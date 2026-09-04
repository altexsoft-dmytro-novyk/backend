import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccessJournalAccessService } from '../../domain/services/access-journal-access.service';
import { AccessJournalService } from '../../domain/services/access-journal.service';
import {
  toAccessJournalRow,
  type AccessJournalEnvelope,
} from '../dtos/access-journal.response';

// Story 4.1 — the `GET /users/:id/access-journal` handler. The read gate is
// enforced HERE, not by `AccessControlGuard`: §3.4 admits only the subject's
// current Reporting-line manager or assigned People Partner — NOT self, NOT HR
// Admin by functional role — which is neither the S1 `RequireFeatureForTarget`
// audience nor a no-target capability. `401` for a missing/invalid token comes
// from the class-level `SessionGuard`.
@Injectable()
export class GetAccessJournalAction {
  constructor(
    private readonly accessJournal: AccessJournalService,
    private readonly accessJournalAccess: AccessJournalAccessService,
  ) {}

  async execute(
    viewerId: string,
    subjectId: string,
  ): Promise<AccessJournalEnvelope> {
    // Read gate first — a single 403 covers self, colleague, HR-Admin-by-FR AND
    // a nonexistent subject (an unresolved subject yields an empty audience
    // set), so there is no 404 enumeration surface.
    const canRead = await this.accessJournalAccess.canRead(viewerId, subjectId);
    if (!canRead) {
      throw new ForbiddenException();
    }

    const rows = await this.accessJournal.listForSubject(subjectId);
    return { data: rows.map(toAccessJournalRow) };
  }
}
