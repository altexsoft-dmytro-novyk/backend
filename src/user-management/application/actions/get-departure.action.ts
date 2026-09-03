import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DepartureService,
  type DepartureView,
} from '../../domain/services/departure.service';

// Story 5.1 — the `GET /users/:id/departures/:departureId` handler. Same
// capability gate as recording (`employee:departure:record`). `404` when the id
// is unknown or belongs to another user (leak-free — one status for both).
@Injectable()
export class GetDepartureAction {
  constructor(private readonly departures: DepartureService) {}

  async execute(
    _actorId: string,
    subjectId: string,
    departureId: string,
  ): Promise<DepartureView> {
    const view = await this.departures.getDeparture(subjectId, departureId);
    if (!view) {
      throw new NotFoundException();
    }
    return view;
  }
}
