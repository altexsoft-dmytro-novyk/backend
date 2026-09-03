import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessJournal } from '../../generated/prisma/client';
import type { AccessJournalRepositoryPort } from '../domain/interfaces/access-journal.repository.port';

// Story 4.1 — the Prisma-backed reader for the §3.4 `access_journal` collection.
// The WRITE path is not here: journal rows are co-written inside the
// `Relationship` mutation's transaction by `OrgRelationshipRepository` (AD-11).
@Injectable()
export class AccessJournalRepository implements AccessJournalRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  listForSubject(subjectUserId: string): Promise<AccessJournal[]> {
    return this.prisma.accessJournal.findMany({
      where: { subjectUserId },
      // §3.4 read order: newest-first. `id` (uuidv7, time-ordered) is the stable
      // tie-breaker for rows sharing an `occurredAt`.
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
  }
}
