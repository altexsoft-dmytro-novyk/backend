import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DepartureService } from '../../domain/services/departure.service';

// Epic 5 Story 5.2 — the `POST /users/:id/departures/:departureId/retry` handler.
// Same capability gate as recording (`employee:departure:record`, no-target
// `isAllowed`); no distinct retry permission (um-dep-03 decision 5). `202` when
// the row is `retry_wait` (made immediately eligible + a synchronous fenced
// claim/apply pass); `404` when the id is unknown or not that user's; `409`
// `{ error: 'departure_not_retryable' }` for any other state.
@Injectable()
export class RetryDepartureAction {
  constructor(private readonly departures: DepartureService) {}

  async execute(
    _actorId: string,
    subjectId: string,
    departureId: string,
  ): Promise<void> {
    const outcome = await this.departures.retryDeparture(
      subjectId,
      departureId,
    );
    if (outcome === 'not_found') {
      throw new NotFoundException();
    }
    if (outcome === 'not_retryable') {
      throw new ConflictException({ error: 'departure_not_retryable' });
    }
  }
}
