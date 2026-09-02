import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CareerTimelineAccessService } from '../../domain/services/career-timeline-access.service';
import { CareerTimelineService } from '../../domain/services/career-timeline.service';

// Story 3.3 — the `DELETE /users/:id/events/:eventId` soft-delete handler. Like
// `AddManualUserEventAction`, the write gate is enforced HERE, not by a
// controller decorator: at this stage it is `isAllowed(viewer,
// 'profile:timeline:write')` ALONE — a feature action, no data-audience half
// (career-timeline/README.md, Dmytro 2026-09-03). `401` for a missing/invalid
// token is produced by the class-level `SessionGuard`.
@Injectable()
export class SoftDeleteUserEventAction {
  constructor(
    private readonly careerTimeline: CareerTimelineService,
    private readonly careerTimelineAccess: CareerTimelineAccessService,
  ) {}

  async execute(
    viewerId: string,
    targetUserId: string,
    eventId: string,
  ): Promise<void> {
    // Permission gate first → `403`. This also covers a nonexistent `:id`
    // (no `404` enumeration surface), consistent with the other timeline
    // actions.
    if (!(await this.careerTimelineAccess.canEdit(viewerId, targetUserId))) {
      throw new ForbiddenException();
    }

    // Then the `(:id, :eventId)`-scoped, still-active lookup. `false` covers an
    // unknown `eventId`, an event on a different user's timeline, and an
    // already-soft-deleted event — all → `404`, never an idempotent `204`.
    const softDeleted = await this.careerTimeline.softDeleteEvent(
      targetUserId,
      eventId,
    );
    if (!softDeleted) {
      throw new NotFoundException();
    }
  }
}
