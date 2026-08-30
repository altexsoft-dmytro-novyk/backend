import { Injectable } from '@nestjs/common';
import { OrgGraphQueryService } from '../../domain/services/org-graph-query.service';

// The only class access-control ever imports from user-management (AD-2
// entry-point rule) — nothing outside this module names the domain
// service, the port, or the Prisma-backed repository directly. Consumed by
// access-control/infrastructure/org-graph-reader.adapter.ts.
@Injectable()
export class OrgGraphQueryAction {
  constructor(private readonly orgGraphQuery: OrgGraphQueryService) {}

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
