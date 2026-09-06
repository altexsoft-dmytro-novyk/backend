import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEmpty,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  workEmail?: string;

  @IsOptional()
  @IsString()
  workPhone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  birthDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  birthMonth?: number;

  @IsOptional()
  @IsDateString()
  companyJoinDate?: string;

  @IsOptional()
  @IsString()
  ttId?: string;

  // Structurally excluded, not just ignored: photo (Story 1.3's own PUT
  // endpoint) and isActive (Story 1.4's own DELETE endpoint) never belong
  // to the general edit surface, even if whitelist stripping were ever
  // misconfigured.
  @IsEmpty()
  photo?: string;

  @IsEmpty()
  isActive?: boolean;

  @IsEmpty()
  id?: string;

  @IsEmpty()
  createdAt?: string;

  @IsEmpty()
  createdBy?: string;

  // Organisational relationships (manager / reporting line / People Partner /
  // department) are read-only through the §3.2 S1 (profile:identity) card for
  // every audience — they change only
  // through Epic 4's organisational-relationship screen (§3.2 fn 1). Declared
  // here so `class-validator` SEES the key and rejects it with an explicit 400,
  // rather than the global `whitelist: true` pipe silently stripping it.
  @IsEmpty({ message: 'manager is not editable through this endpoint' })
  manager?: unknown;

  @IsEmpty({ message: 'managerId is not editable through this endpoint' })
  managerId?: unknown;

  @IsEmpty({ message: 'reportsToUserId is not editable through this endpoint' })
  reportsToUserId?: unknown;

  @IsEmpty({ message: 'peoplePartner is not editable through this endpoint' })
  peoplePartner?: unknown;

  @IsEmpty({ message: 'peoplePartnerId is not editable through this endpoint' })
  peoplePartnerId?: unknown;

  @IsEmpty({ message: 'department is not editable through this endpoint' })
  department?: unknown;

  @IsEmpty({ message: 'departmentId is not editable through this endpoint' })
  departmentId?: unknown;

  // Employment status is Epic 2's fact table, not a §3.2 S1 scalar; custom fields
  // have their own Story 1.6 surface. Neither is editable here.
  @IsEmpty({
    message: 'employmentStatus is not editable through this endpoint',
  })
  employmentStatus?: unknown;

  @IsEmpty({ message: 'customFields is not editable through this endpoint' })
  customFields?: unknown;
}
