import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type UserEvent } from '../../generated/prisma/client';
import type {
  ManualEventInput,
  UserEventRepositoryPort,
} from '../domain/interfaces/user-event.repository.port';

// Story 3.1 — the Prisma-backed reader for the `user_events` career-timeline
// sub-collection. The AUTO-event write path is not here: auto-events are
// co-written by `UserRepository.update` inside the same `$transaction` as the
// triggering `user.update` (AD-11), and the import writes `joined_company`
// directly in `population-import.repository.ts`. Story 3.2 adds the standalone
// MANUAL insert (`add`) — a backfill entry has no sibling mutation.
@Injectable()
export class UserEventRepository implements UserEventRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<UserEvent[]> {
    return this.prisma.userEvent.findMany({
      where: { userId, deletedAt: null },
      // Chronological; `createdAt` is the stable tie-breaker for same-day events.
      orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  add(input: ManualEventInput): Promise<UserEvent> {
    return this.prisma.userEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        eventDate: input.eventDate,
        details: input.details as Prisma.InputJsonValue,
        source: input.source,
        createdBy: input.createdBy,
        // `deletedAt` left null (the column default) — a manual add is active.
      },
    });
  }

  findActiveOnTimeline(
    userId: string,
    eventId: string,
  ): Promise<UserEvent | null> {
    // Single scoped query: id + owning timeline + still-active. A cross-timeline
    // id, an unknown id and an already soft-deleted row all return `null`.
    return this.prisma.userEvent.findFirst({
      where: { id: eventId, userId, deletedAt: null },
    });
  }

  async softDelete(eventId: string): Promise<void> {
    await this.prisma.userEvent.update({
      where: { id: eventId },
      data: { deletedAt: new Date() },
    });
  }
}
