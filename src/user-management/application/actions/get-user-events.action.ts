import { ForbiddenException, Injectable } from '@nestjs/common';
import { CareerTimelineAccessService } from '../../domain/services/career-timeline-access.service';
import { CareerTimelineService } from '../../domain/services/career-timeline.service';
import {
  toUserEventResponse,
  type UserEventsEnvelope,
} from '../dtos/user-event.response';

// Story 3.1 — the `GET /users/:id/events` handler. The read gate is enforced
// HERE, not by a route guard: the career-timeline §3.2 S9 read audience
// EXCLUDES colleague, unlike `@RequireSectionAccess('profile:identity',
// 'read')`, which admits any non-empty audience. `401` for a missing/invalid
// token is produced by the class-level `SessionGuard`.
@Injectable()
export class GetUserEventsAction {
  constructor(
    private readonly careerTimeline: CareerTimelineService,
    private readonly careerTimelineAccess: CareerTimelineAccessService,
  ) {}

  async execute(
    viewerId: string,
    targetId: string,
  ): Promise<UserEventsEnvelope> {
    // Read gate first — a single 403 covers colleague AND a nonexistent target
    // (an unresolved target yields an empty audience set), so there is no 404
    // enumeration surface (§3.3.1: a `—` cell must not leak).
    const canRead = await this.careerTimelineAccess.canRead(viewerId, targetId);
    if (!canRead) {
      throw new ForbiddenException();
    }

    const events = await this.careerTimeline.listForUser(targetId);
    const canEdit = await this.careerTimelineAccess.canEdit(viewerId, targetId);

    return {
      data: events.map(toUserEventResponse),
      canEdit,
    };
  }
}
