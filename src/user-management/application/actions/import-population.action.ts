import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PopulationImportService,
  type ImportSummary,
  type RawPopulationRow,
} from '../../domain/services/population-import.service';

/**
 * The delivered semicolon-CSV header, verbatim (`docs/Accounts_template.csv`).
 * A file whose header row is missing or does not match this exact ordered set
 * is a file-level failure → `400`, nothing written (seed README).
 */
export const POPULATION_CSV_COLUMNS = [
  'FirstName',
  'LastName',
  'Email',
  'Birthday',
  'PositionId',
  'PositionName',
  'RegistrationDate',
  'DepartmentId',
  'DepartmentName',
  'DismissedDate',
  'IsDismissed',
  'EmployeeType',
  'TimeZone',
  'CountryId',
  'CountryCode',
  'CountryName',
  'CountryStateId',
  'CountryStateName',
] as const;

/**
 * Story 1.1 — orchestrates `POST /users/import` (and the `db:import:population`
 * deploy script): parse the delivered semicolon CSV, validate the header
 * (file-level `400` on mismatch — zero writes), then hand the raw rows to the
 * idempotent import writer. Row-level problems are per-row skips reported in the
 * `200` summary; they never fail the request.
 */
@Injectable()
export class ImportPopulationAction {
  constructor(
    private readonly populationImportService: PopulationImportService,
  ) {}

  async execute(file: Buffer, operatorId: string): Promise<ImportSummary> {
    const rows = this.parseCsv(file);
    return this.populationImportService.import(rows, operatorId);
  }

  /** Strict reader for the delivered export: strips a UTF-8 BOM, splits on `;`,
   *  requires the exact delivered header. No quoting rules — the TT export has
   *  none. Any structural problem is a file-level `BadRequestException`. */
  private parseCsv(file: Buffer): RawPopulationRow[] {
    if (!file || file.length === 0) {
      throw new BadRequestException('the uploaded file is empty');
    }

    const raw = file.toString('utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      throw new BadRequestException('the uploaded file has no rows');
    }

    const header = lines[0].split(';').map((column) => column.trim());
    if (!this.headerMatches(header)) {
      throw new BadRequestException(
        'the file header does not match the expected timetracker export columns',
      );
    }

    return lines.slice(1).map((line) => {
      const cells = line.split(';');
      const row: RawPopulationRow = {};
      POPULATION_CSV_COLUMNS.forEach((column, index) => {
        row[column] = cells[index] ?? '';
      });
      return row;
    });
  }

  private headerMatches(header: string[]): boolean {
    if (header.length !== POPULATION_CSV_COLUMNS.length) return false;
    return POPULATION_CSV_COLUMNS.every(
      (column, index) => header[index] === column,
    );
  }
}
