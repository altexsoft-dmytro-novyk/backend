import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { UserEvent } from '../../generated/prisma/client';
import type { UserEventRepositoryPort } from '../domain/interfaces/user-event.repository.port';

// Story 3.1 — the Prisma-backed reader for the `user_events` career-timeline
// sub-collection. The WRITE path is not here: auto-events are co-written by
// `UserRepository.update` inside the same `$transaction` as the triggering
// `user.update` (AD-11), and the import writes `joined_company` directly in
// `population-import.repository.ts`.
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
}
