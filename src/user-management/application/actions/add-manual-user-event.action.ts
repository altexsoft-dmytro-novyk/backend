import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { CareerTimelineAccessService } from '../../domain/services/career-timeline-access.service';
import { CareerTimelineService } from '../../domain/services/career-timeline.service';
import { UserService } from '../../domain/services/user.service';
import type { CreateUserEventDto } from '../dtos/create-user-event.dto';
import {
  toUserEventResponse,
  type UserEventResponse,
} from '../dtos/user-event.response';

// Story 3.2 — the `POST /users/:id/events` manual-backfill handler. The write
// gate is enforced HERE, not by a controller decorator (same as
// `GetUserEventsAction`): at this stage it is `isAllowed(viewer,
// 'profile:timeline:write')` ALONE — a feature action, no data-audience half
// (career-timeline/README.md, Dmytro 2026-09-02). `401` for a missing/invalid
// token is produced by the class-level `SessionGuard`.
@Injectable()
export class AddManualUserEventAction {
  private readonly logger = new Logger(AddManualUserEventAction.name);

  constructor(
    private readonly careerTimeline: CareerTimelineService,
    private readonly careerTimelineAccess: CareerTimelineAccessService,
    private readonly userService: UserService,
  ) {}

  async execute(
    viewerId: string,
    targetId: string,
    dto: CreateUserEventDto,
  ): Promise<UserEventResponse> {
    // A single 403 covers both "no permission" AND a nonexistent target — no
    // 404 enumeration surface, consistent with `GetUserEventsAction`. The
    // feature-action-only gate does not itself fail closed on a missing target
    // (it has no data-audience half at this stage), so the existence check is
    // explicit — and still answers 403, never 404.
    const canEdit = await this.careerTimelineAccess.canEdit(viewerId, targetId);
    if (!canEdit) {
      throw new ForbiddenException();
    }
    const target = await this.userService.findById(targetId);
    if (!target) {
      throw new ForbiddenException();
    }

    const created = await this.careerTimeline.addManualEvent({
      userId: targetId,
      type: dto.type,
      // `@db.Date` column; parsed to a UTC instant ("в UTC, як і інші всі
      // дати", Dmytro 2026-09-02).
      eventDate: new Date(dto.eventDate),
      details: dto.details ?? {},
      createdBy: viewerId,
    });

    this.logger.log(
      `manual timeline event "${dto.type}" added to ${targetId} by ${viewerId} (event ${created.id})`,
    );

    // Bare resource — Nest returns `201` for a POST by default. NOT the
    // `{ data, canEdit }` envelope (matches bare-user `PATCH /users/:id`).
    return toUserEventResponse(created);
  }
}
