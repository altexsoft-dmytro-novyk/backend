import { Inject, Injectable } from '@nestjs/common';
import { ORG_GRAPH_REPOSITORY_PORT } from '../interfaces/org-graph-repository.port';
import type { OrgGraphRepositoryPort } from '../interfaces/org-graph-repository.port';

// AD-1: the only holder of ORG_GRAPH_REPOSITORY_PORT. application/actions/
// depend on this service, never the port token directly.
@Injectable()
export class OrgGraphQueryService {
  constructor(
    @Inject(ORG_GRAPH_REPOSITORY_PORT)
    private readonly repo: OrgGraphRepositoryPort,
  ) {}

  isDeparted(userId: string): Promise<boolean> {
    return this.repo.isDeparted(userId);
  }

  isInReportingLine(actorId: string, targetId: string): Promise<boolean> {
    return this.repo.isInReportingLine(actorId, targetId);
  }

  isDirectManager(actorId: string, targetId: string): Promise<boolean> {
    return this.repo.isDirectManager(actorId, targetId);
  }

  isAssignedPP(actorId: string, targetId: string): Promise<boolean> {
    return this.repo.isAssignedPP(actorId, targetId);
  }

  userExists(userId: string): Promise<boolean> {
    return this.repo.userExists(userId);
  }
}
