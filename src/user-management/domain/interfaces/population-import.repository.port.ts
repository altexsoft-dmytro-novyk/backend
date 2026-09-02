// The transactional writer seam for the Story 1.1 seeded-population import
// (AD-16). One `writeRow` call = one database transaction: the row's `User`,
// its `DepartmentMembership`, its `EmploymentStatus`, and — for a new user —
// its `joined_company` `UserEvent` commit together, or the row is left
// untouched (`um-seed-13` per-row all-or-nothing).
//
// `domain/services/population-import.service.ts` is the only holder of this
// port (AD-2); `application/actions/` depends on that service, never on the
// token.

/** A structurally valid, normalized import row ready to be written. */
export interface ParsedImportRow {
  /** 1-based data-row number (header excluded) — surfaces in `errors[].line`. */
  line: number;
  /** `trim().toLowerCase()` of the CSV `Email` (DEC-UM-007) — the natural key. */
  workEmail: string;
  firstName: string;
  lastName: string;
  position: string;
  country: string;
  /** 1-31, paired with `birthMonth`; both null or both set (never a half-pair). */
  birthDay: number | null;
  /** 1-12, paired with `birthDay`. */
  birthMonth: number | null;
  /** CSV `RegistrationDate` — `User.companyJoinDate` AND `DepartmentMembership.validFrom`. */
  companyJoinDate: Date;
  /** CSV `DepartmentId` (string, nullable) + `DepartmentName`. Identity is the pair. */
  department: { externalId: string | null; name: string };
  /** Derived from `IsDismissed` + dates. */
  employment:
    | { status: 'active'; validFrom: Date }
    | { status: 'dismissed'; validFrom: Date };
}

export interface RowWriteResult {
  outcome: 'created' | 'updated';
  /** `true` iff this row inserted a new `Department` (drives `departmentsCreated`). */
  departmentCreated: boolean;
}

/** A row-level failure discovered only at write time (e.g. an ambiguous
 *  pre-existing normalized-email match). The service turns it into a per-row
 *  skip with this `reason`; the row's transaction is rolled back. */
export class PopulationImportRowError extends Error {}

export interface PopulationImportRepositoryPort {
  writeRow(row: ParsedImportRow, operatorId: string): Promise<RowWriteResult>;
}

export const POPULATION_IMPORT_REPOSITORY_PORT = Symbol(
  'POPULATION_IMPORT_REPOSITORY_PORT',
);
