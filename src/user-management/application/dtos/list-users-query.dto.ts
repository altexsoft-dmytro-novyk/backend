import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dtos/pagination-query.dto';

// Story 1.5 — the ONLY accepted `GET /users` query params. Anything else
// (`ttId`, `isActive`, `sort`, `order`, unknown keys) is rejected 400 by the
// route-scoped `forbidNonWhitelisted` pipe (see UsersController#findAll):
// FR-15 internal columns are never filterable, and there is no sort override.
export class ListUsersQueryDto extends PaginationQueryDto {
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
  @IsString()
  workEmail?: string;

  @IsOptional()
  @IsString()
  workPhone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  birthDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  birthMonth?: number;

  @IsOptional()
  @IsDateString()
  companyJoinDate?: string;

  // Absent → active only. Gated by `user-management:list` alone (no new
  // capability) — README §6.
  @IsOptional()
  @IsIn(['active', 'dismissed'])
  employmentStatus?: 'active' | 'dismissed';
}
