import { Inject, Injectable } from '@nestjs/common';
import {
  POPULATION_IMPORT_REPOSITORY_PORT,
  PopulationImportRowError,
  type ParsedImportRow,
  type PopulationImportRepositoryPort,
} from '../interfaces/population-import.repository.port';

/** One raw CSV data row, keyed by the delivered column names. */
export type RawPopulationRow = Record<string, string>;

export interface ImportError {
  line: number;
  email: string | null;
  reason: string;
}

export interface ImportSummary {
  created: number;
  updated: number;
  departmentsCreated: number;
  skipped: number;
  errors: ImportError[];
}

const isCsvNull = (value: string | undefined): boolean =>
  value === undefined ||
  value.trim() === '' ||
  value.trim().toUpperCase() === 'NULL';

const cell = (row: RawPopulationRow, column: string): string =>
  (row[column] ?? '').trim();

/** Strict ISO `YYYY-MM-DD` → a UTC-midnight `Date`, or `null` if unparseable
 *  (rejects out-of-range months/days and non-existent dates like `2026-02-30`). */
function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

type ParseOutcome =
  | { ok: true; row: ParsedImportRow }
  | { ok: false; email: string | null; reason: string };

/**
 * Story 1.1 — the idempotent seeded-population import writer (AD-16).
 *
 * Pure orchestration: maps each raw CSV row to the domain shape (column mapping
 * per `epic-1-story-1-1-decisions.md` §5), normalizes `workEmail`
 * (`trim().toLowerCase()`, DEC-UM-007), applies every row-level validation, then
 * hands each good row to the transactional repository ONE ROW PER TRANSACTION.
 * A row-level problem (missing field, unparseable date, in-file duplicate email,
 * ambiguous pre-existing match) is a per-row skip with an `errors[]` entry — the
 * rest of the import still commits. There is no whole-import `400` branch (that
 * is a file-level failure, caught in the action before this runs).
 *
 * The same writer backs `POST /users/import` and the `db:import:population`
 * deploy script — the second timetracker-API source path plugs in here later
 * without reworking this class.
 */
@Injectable()
export class PopulationImportService {
  constructor(
    @Inject(POPULATION_IMPORT_REPOSITORY_PORT)
    private readonly repository: PopulationImportRepositoryPort,
  ) {}

  async import(
    rawRows: RawPopulationRow[],
    operatorId: string,
  ): Promise<ImportSummary> {
    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      departmentsCreated: 0,
      skipped: 0,
      errors: [],
    };
    const processedEmails = new Set<string>();

    let line = 0;
    for (const raw of rawRows) {
      line += 1;

      const parsed = this.parseRow(raw, line);
      if (!parsed.ok) {
        summary.skipped += 1;
        summary.errors.push({
          line,
          email: parsed.email,
          reason: parsed.reason,
        });
        continue;
      }

      if (processedEmails.has(parsed.row.workEmail)) {
        summary.skipped += 1;
        summary.errors.push({
          line,
          email: parsed.row.workEmail,
          reason: 'email already exists',
        });
        continue;
      }

      try {
        const result = await this.repository.writeRow(parsed.row, operatorId);
        processedEmails.add(parsed.row.workEmail);
        if (result.outcome === 'created') summary.created += 1;
        else summary.updated += 1;
        if (result.departmentCreated) summary.departmentsCreated += 1;
      } catch (error) {
        summary.skipped += 1;
        summary.errors.push({
          line,
          email: parsed.row.workEmail,
          reason:
            error instanceof PopulationImportRowError
              ? error.message
              : 'row import failed',
        });
      }
    }

    return summary;
  }

  private parseRow(raw: RawPopulationRow, line: number): ParseOutcome {
    const rawEmail = cell(raw, 'Email');
    if (isCsvNull(rawEmail)) {
      return { ok: false, email: null, reason: 'email is required' };
    }
    const workEmail = rawEmail.toLowerCase();

    const firstName = cell(raw, 'FirstName');
    const lastName = cell(raw, 'LastName');
    if (isCsvNull(firstName)) {
      return { ok: false, email: workEmail, reason: 'first name is required' };
    }
    if (isCsvNull(lastName)) {
      return { ok: false, email: workEmail, reason: 'last name is required' };
    }

    const position = cell(raw, 'PositionName');
    const country = isCsvNull(cell(raw, 'CountryName'))
      ? ''
      : cell(raw, 'CountryName');

    const registrationRaw = cell(raw, 'RegistrationDate');
    const companyJoinDate = parseIsoDate(registrationRaw);
    if (!companyJoinDate) {
      return {
        ok: false,
        email: workEmail,
        reason: 'unparseable registration date',
      };
    }

    // Birthday: NULL → both null; a date → split day/month, year dropped;
    // never a half-pair.
    let birthDay: number | null = null;
    let birthMonth: number | null = null;
    const birthdayRaw = cell(raw, 'Birthday');
    if (!isCsvNull(birthdayRaw)) {
      const birthday = parseIsoDate(birthdayRaw);
      if (!birthday) {
        return { ok: false, email: workEmail, reason: 'unparseable birthday' };
      }
      birthDay = birthday.getUTCDate();
      birthMonth = birthday.getUTCMonth() + 1;
    }

    // EmploymentStatus from IsDismissed (+ dates).
    const isDismissed = cell(raw, 'IsDismissed') === '1';
    let employment: ParsedImportRow['employment'];
    if (isDismissed) {
      const dismissedRaw = cell(raw, 'DismissedDate');
      if (isCsvNull(dismissedRaw)) {
        return {
          ok: false,
          email: workEmail,
          reason: 'dismissed row has no dismissed date',
        };
      }
      const dismissedDate = parseIsoDate(dismissedRaw);
      if (!dismissedDate) {
        return {
          ok: false,
          email: workEmail,
          reason: 'unparseable dismissed date',
        };
      }
      employment = { status: 'dismissed', validFrom: dismissedDate };
    } else {
      employment = { status: 'active', validFrom: companyJoinDate };
    }

    const departmentName = cell(raw, 'DepartmentName');
    if (isCsvNull(departmentName)) {
      return {
        ok: false,
        email: workEmail,
        reason: 'department name is required',
      };
    }
    const departmentExternalIdRaw = cell(raw, 'DepartmentId');
    const departmentExternalId = isCsvNull(departmentExternalIdRaw)
      ? null
      : departmentExternalIdRaw;

    return {
      ok: true,
      row: {
        line,
        workEmail,
        firstName,
        lastName,
        position,
        country,
        birthDay,
        birthMonth,
        companyJoinDate,
        department: { externalId: departmentExternalId, name: departmentName },
        employment,
      },
    };
  }
}
