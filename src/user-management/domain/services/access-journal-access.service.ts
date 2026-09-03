import { Inject, Injectable } from '@nestjs/common';
import {
  ACCESS_JOURNAL_ACCESS_PORT,
  type AccessJournalAccessPort,
} from '../interfaces/access-journal-access.port';

// The `domain/services/` seam for the access-journal read-authorization fact
// (AD-2: `application/actions/` depend on this service, never on the port
// token). Mirrors `CareerTimelineAccessService`.
@Injectable()
export class AccessJournalAccessService {
  constructor(
    @Inject(ACCESS_JOURNAL_ACCESS_PORT)
    private readonly access: AccessJournalAccessPort,
  ) {}

  canRead(viewerId: string, subjectId: string): Promise<boolean> {
    return this.access.canReadAccessJournal(viewerId, subjectId);
  }
}
