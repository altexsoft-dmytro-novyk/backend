import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  DepartureService,
  type DepartureView,
} from '../../domain/services/departure.service';
import { RecordDepartureDto } from '../dtos/record-departure.dto';

// Story 5.1 — the `POST /users/:id/departures` handler. The capability gate
// (`employee:departure:record`) is `AccessControlGuard` via `@RequireFeature`
// (no-target `isAllowed` — DEC-UM-002, never a `User.position` check);
// `SessionGuard` gives the `401`. Replay authorization is rechecked by the same
// guard on every call, so a caller who lost the grant gets `403` before this
// action runs (um-dep-06 T5). This action owns only the `400` shape checks and
// the outcome → HTTP mapping; the blocker check + idempotency semantics are in
// the domain service.
@Injectable()
export class RecordDepartureAction {
  constructor(private readonly departures: DepartureService) {}

  async execute(
    actorId: string,
    subjectId: string,
    dto: RecordDepartureDto,
    idempotencyKey: string | undefined,
  ): Promise<DepartureView> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('the Idempotency-Key header is required');
    }

    const effectiveInstant = Date.parse(
      `${dto.effectiveDate.slice(0, 10)}T00:00:00.000Z`,
    );
    const todayInstant = Date.parse(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    if (Number.isNaN(effectiveInstant) || effectiveInstant <= todayInstant) {
      throw new BadRequestException('effectiveDate must be a future date');
    }

    const outcome = await this.departures.recordDeparture({
      userId: subjectId,
      effectiveDate: dto.effectiveDate,
      reason: dto.reason,
      idempotencyKey,
      createdBy: actorId,
    });

    if (outcome.kind === 'conflict') {
      throw new ConflictException(outcome.body);
    }
    return outcome.view;
  }
}
