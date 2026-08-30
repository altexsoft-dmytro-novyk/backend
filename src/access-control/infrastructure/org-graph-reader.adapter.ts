import { Injectable } from '@nestjs/common';
import { OrgGraphQueryAction } from '../../user-management/application/actions/org-graph-query.action';
import { OrgGraphReaderPort } from '../domain/interfaces/org-graph-reader.port';

// AD-2/AD-3: the only place access-control names user-management at all —
// consumes exactly its application-layer export (OrgGraphQueryAction),
// never its domain or infrastructure.
@Injectable()
export class OrgGraphReaderAdapter implements OrgGraphReaderPort {
  constructor(private readonly orgGraphQuery: OrgGraphQueryAction) {}

  isDeparted(userId: string): Promise<boolean> {
    return this.orgGraphQuery.isDeparted(userId);
  }

  isInReportingLine(actorId: string, targetId: string): Promise<boolean> {
    return this.orgGraphQuery.isInReportingLine(actorId, targetId);
  }

  isDirectManager(actorId: string, targetId: string): Promise<boolean> {
    return this.orgGraphQuery.isDirectManager(actorId, targetId);
  }

  isAssignedPP(actorId: string, targetId: string): Promise<boolean> {
    return this.orgGraphQuery.isAssignedPP(actorId, targetId);
  }

  userExists(userId: string): Promise<boolean> {
    return this.orgGraphQuery.userExists(userId);
  }
}
