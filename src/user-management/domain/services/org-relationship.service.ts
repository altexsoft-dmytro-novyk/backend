import { Inject, Injectable } from '@nestjs/common';
import type { Relationship } from '../../../generated/prisma/client';
import {
  ORG_RELATIONSHIP_WRITER_PORT,
  type AddDepartmentMembershipCommand,
  type AddDepartmentMembershipResult,
  type AssignManagerCommand,
  type ChangePeoplePartnerCommand,
  type ChangePeoplePartnerResult,
  type DepartmentManagerContext,
  type OrgRelationshipWriterPort,
  type RemoveDepartmentManagerCommand,
  type RemoveDepartmentManagerResult,
  type RemoveDepartmentMembershipCommand,
  type RemoveDepartmentMembershipResult,
  type RemovePeoplePartnerCommand,
  type RemovePeoplePartnerResult,
  type RevokeManagerCommand,
  type SetDepartmentManagerCommand,
  type SetDepartmentManagerResult,
} from '../interfaces/org-relationship-writer.port';

// The `domain/services/` seam for the Epic 4 organisational-relationship write
// paths (AD-2: `application/actions/` depend on this service, never on the port
// token). It holds `ORG_RELATIONSHIP_WRITER_PORT` the same way
// `CareerTimelineService` holds its repository port; it never imports Prisma,
// HTTP types, or an adapter class. Self-assignment rejection and the
// 404/409 HTTP mapping live in the actions / infrastructure, not here.
@Injectable()
export class OrgRelationshipService {
  constructor(
    @Inject(ORG_RELATIONSHIP_WRITER_PORT)
    private readonly writer: OrgRelationshipWriterPort,
  ) {}

  assignManager(command: AssignManagerCommand): Promise<Relationship> {
    return this.writer.assignManager(command);
  }

  revokeManager(command: RevokeManagerCommand): Promise<boolean> {
    return this.writer.revokeManager(command);
  }

  changePeoplePartner(
    command: ChangePeoplePartnerCommand,
  ): Promise<ChangePeoplePartnerResult> {
    return this.writer.changePeoplePartner(command);
  }

  removePeoplePartner(
    command: RemovePeoplePartnerCommand,
  ): Promise<RemovePeoplePartnerResult> {
    return this.writer.removePeoplePartner(command);
  }

  loadDepartmentManagerContext(
    deptId: string,
  ): Promise<DepartmentManagerContext> {
    return this.writer.loadDepartmentManagerContext(deptId);
  }

  addOrMoveDepartmentMembership(
    command: AddDepartmentMembershipCommand,
  ): Promise<AddDepartmentMembershipResult> {
    return this.writer.addOrMoveDepartmentMembership(command);
  }

  removeDepartmentMembership(
    command: RemoveDepartmentMembershipCommand,
  ): Promise<RemoveDepartmentMembershipResult> {
    return this.writer.removeDepartmentMembership(command);
  }

  setDepartmentManager(
    command: SetDepartmentManagerCommand,
  ): Promise<SetDepartmentManagerResult> {
    return this.writer.setDepartmentManager(command);
  }

  removeDepartmentManager(
    command: RemoveDepartmentManagerCommand,
  ): Promise<RemoveDepartmentManagerResult> {
    return this.writer.removeDepartmentManager(command);
  }
}
