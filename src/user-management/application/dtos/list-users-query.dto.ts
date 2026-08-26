import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dtos/pagination-query.dto';

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

  @IsOptional()
  @IsString()
  ttId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}
