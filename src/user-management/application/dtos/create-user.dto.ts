import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEmpty,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  lastName!: string;

  // position/country/city/companyJoinDate are required (DEC below), but
  // enforced in RegisterUserAction rather than here: um-reg-04 requires the
  // duplicate-workEmail check to take priority over missing-field
  // validation for the same request, so completeness can't be an eager
  // pipe-level gate — see the action's own comment for the full ordering.
  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  workEmail!: string;

  @IsOptional()
  @IsString()
  workPhone?: string;

  @ValidateIf(
    (o: CreateUserDto) =>
      o.birthDay !== undefined || o.birthMonth !== undefined,
  )
  @IsInt()
  @Min(1)
  @Max(31)
  birthDay?: number;

  @ValidateIf(
    (o: CreateUserDto) =>
      o.birthDay !== undefined || o.birthMonth !== undefined,
  )
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

  // Server-owned fields (DEC-UM-006): must be entirely absent, never
  // silently stripped — a client-supplied value here is rejected, not ignored.
  @IsEmpty()
  id?: string;

  @IsEmpty()
  createdAt?: string;

  @IsEmpty()
  createdBy?: string;
}
