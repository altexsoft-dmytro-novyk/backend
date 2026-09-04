import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

// Body for `POST /users/:id/departure-reparenting`.
export class DepartureReparentingDto {
  @IsUUID()
  targetId!: string;

  @IsString()
  @IsNotEmpty()
  expectedBlockerVersion!: string;
}
