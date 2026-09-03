import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

// Body for `POST /users/:id/departures`. The future-date rule and the required
// `Idempotency-Key` header are enforced in `RecordDepartureAction` (both `400`).
export class RecordDepartureDto {
  @IsDateString()
  effectiveDate!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
