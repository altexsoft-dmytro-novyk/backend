import { Inject, Injectable } from '@nestjs/common';
import {
  ORG_RELATIONSHIPS_READ_ACCESS_PORT,
  type OrgRelationshipsReadAccessPort,
} from '../interfaces/org-relationships-read-access.port';

// The `domain/services/` seam for the `GET /users/:id/relationships` read-gate
// fact (AD-2: `application/actions/` depend on this service, never on the port
// token). Mirrors `AccessJournalAccessService`.
@Injectable()
export class OrgRelationshipsReadAccessService {
  constructor(
    @Inject(ORG_RELATIONSHIPS_READ_ACCESS_PORT)
    private readonly access: OrgRelationshipsReadAccessPort,
  ) {}

  canRead(viewerId: string, subjectId: string): Promise<boolean> {
    return this.access.canRead(viewerId, subjectId);
  }
}
