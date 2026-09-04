import { Inject, Injectable } from '@nestjs/common';
import {
  ORG_RELATIONSHIP_READER_PORT,
  type CurrentEdge,
  type OrgRelationshipReaderPort,
} from '../interfaces/org-relationship-reader.port';

// The `domain/services/` seam for reading the subject's current org edges (AD-2:
// `application/actions/` depend on this service, never on the port token).
// Thin — a single pass-through today — but the mandatory seam: one place a
// future invariant (e.g. a projection narrowing) gets added without touching the
// action. Mirrors `AccessJournalService`; never imports Prisma, HTTP types, or
// an adapter class.
@Injectable()
export class OrgRelationshipReadService {
  constructor(
    @Inject(ORG_RELATIONSHIP_READER_PORT)
    private readonly reader: OrgRelationshipReaderPort,
  ) {}

  listCurrentEdges(subjectId: string): Promise<CurrentEdge[]> {
    return this.reader.listCurrentEdges(subjectId);
  }
}
