import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRelationshipReadService } from '../../domain/services/org-relationship-read.service';
import { OrgRelationshipsReadAccessService } from '../../domain/services/org-relationships-read-access.service';
import { UserService } from '../../domain/services/user.service';
import {
  toCurrentEdgeView,
  type RelationshipsEnvelope,
} from '../dtos/relationships-view.response';

// Story 6.1 — the `GET /users/:id/relationships` handler. No `@RequireFeature`
// on the route: the read gate (Gate B — `{ reporting, pp }` audience OR
// `isAllowed('org:relationships:write')`) is enforced HERE, mirroring
// `GetAccessJournalAction`. `401` for a missing/invalid token comes from the
// class-level `SessionGuard`.
//
// Ordering matters (PM/AD-24): target existence/activity is resolved BEFORE the
// audience gate, so a hidden target is never distinguishable from an
// un-permitted one.
@Injectable()
export class GetRelationshipsAction {
  constructor(
    private readonly userService: UserService,
    private readonly readAccess: OrgRelationshipsReadAccessService,
    private readonly relationships: OrgRelationshipReadService,
  ) {}

  async execute(
    viewerId: string,
    subjectId: string,
  ): Promise<RelationshipsEnvelope> {
    // 1. 404 first — leak-free, before any audience resolution.
    const target = await this.userService.findById(subjectId);
    if (!target || target.isActive === false) {
      throw new NotFoundException();
    }

    // 2. Reader gate — a single 403 covers self, colleague, and a viewer with
    //    no capability.
    const canRead = await this.readAccess.canRead(viewerId, subjectId);
    if (!canRead) {
      throw new ForbiddenException();
    }

    // 3. Project the current edges. `data: []` when the target has neither.
    const edges = await this.relationships.listCurrentEdges(subjectId);
    return { data: edges.map(toCurrentEdgeView) };
  }
}
