import { Inject, Injectable } from '@nestjs/common';
import {
  CAREER_TIMELINE_ACCESS_PORT,
  type CareerTimelineAccessPort,
} from '../interfaces/career-timeline-access.port';

// The `domain/services/` seam for the career-timeline authorization facts (AD-2:
// `application/actions/` depend on a domain service, never on a port token).
// Mirrors `IdentityCardAccessService`; never imports Prisma, HTTP types, or an
// adapter class.
@Injectable()
export class CareerTimelineAccessService {
  constructor(
    @Inject(CAREER_TIMELINE_ACCESS_PORT)
    private readonly access: CareerTimelineAccessPort,
  ) {}

  canRead(viewerId: string, targetUserId: string): Promise<boolean> {
    return this.access.canReadTimeline(viewerId, targetUserId);
  }

  canEdit(viewerId: string, targetUserId: string): Promise<boolean> {
    return this.access.canEditTimeline(viewerId, targetUserId);
  }
}
