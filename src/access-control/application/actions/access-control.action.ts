import { Injectable } from '@nestjs/common';
import { AccessControlService } from '../../domain/services/access-control.service';
import { AccessLevel, Audience, SectionId } from '../../domain/types';

// CAP-1: the only class user-management ever imports from access-control
// (AD-2 entry-point rule) — nothing outside this module names the domain
// service or either port directly.
@Injectable()
export class AccessControlAction {
  constructor(private readonly accessControl: AccessControlService) {}

  isAllowed(actorId: string, permissionName: string): Promise<boolean> {
    return this.accessControl.isAllowed(actorId, permissionName);
  }

  canAccessSection(
    actorId: string,
    targetId: string,
    section: SectionId,
  ): Promise<AccessLevel> {
    return this.accessControl.canAccessSection(actorId, targetId, section);
  }

  hasSectionWritePermission(
    actorId: string,
    section: SectionId,
  ): Promise<boolean> {
    return this.accessControl.hasSectionWritePermission(actorId, section);
  }

  isDeparted(userId: string): Promise<boolean> {
    return this.accessControl.isDeparted(userId);
  }

  isDirectManager(actorId: string, targetId: string): Promise<boolean> {
    return this.accessControl.isDirectManager(actorId, targetId);
  }

  isAssignedPP(actorId: string, targetId: string): Promise<boolean> {
    return this.accessControl.isAssignedPP(actorId, targetId);
  }

  getAudiences(actorId: string, targetId: string): Promise<Audience[]> {
    return this.accessControl.getAudiences(actorId, targetId);
  }
}
