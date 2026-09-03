import { Inject, Injectable } from '@nestjs/common';
import type { AccessJournal } from '../../../generated/prisma/client';
import {
  ACCESS_JOURNAL_REPOSITORY_PORT,
  type AccessJournalRepositoryPort,
} from '../interfaces/access-journal.repository.port';

// The `domain/services/` seam for reading the §3.4 access journal (AD-2). Holds
// `ACCESS_JOURNAL_REPOSITORY_PORT`; never imports Prisma, HTTP types, or an
// adapter class.
@Injectable()
export class AccessJournalService {
  constructor(
    @Inject(ACCESS_JOURNAL_REPOSITORY_PORT)
    private readonly journal: AccessJournalRepositoryPort,
  ) {}

  listForSubject(subjectUserId: string): Promise<AccessJournal[]> {
    return this.journal.listForSubject(subjectUserId);
  }
}
