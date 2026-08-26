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
}
