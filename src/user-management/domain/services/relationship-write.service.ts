import { Inject, Injectable } from '@nestjs/common';
import {
  RELATIONSHIP_WRITE_REPOSITORY_PORT,
  RelationshipWriteResult,
} from '../interfaces/relationship-write-repository.port';
import type { RelationshipWriteRepositoryPort } from '../interfaces/relationship-write-repository.port';

// Domain-level error, transport-agnostic (AD-1: no NestJS HTTP exception
// classes in domain/) — the controller maps this to 403.
export class SelfAssignmentError extends Error {
  constructor() {
    super('self-assignment is not permitted');
  }
}

// AD-1: only domain/services/ may inject a port token.
//
// AD-8: self-assignment is validated here, in the domain service, never the
// controller — a future second write path (another controller, a script)
// still goes through this same check as long as it calls this service.
// Simplification, documented: epics.md's Story 4.1 AC phrases the rejected
// case as "without already being entitled" (implying a narrow carve-out for
// an actor already entitled some other way), but no story spells out what
// "already entitled" would mean operationally, and every AC across 4.1/4.2/
// 4.3 that exercises this path is a flat "actor assigns themselves ->
// rejected". This service enforces the unconditional, safer reading:
// newHolderId === actorId is always rejected for manager/people_partner/
// department_manager. `department` (an employee's own department) has no
// "holder" concept — moving yourself between departments isn't a
// self-assignment in this sense — so no check applies there.
@Injectable()
export class RelationshipWriteService {
  constructor(
    @Inject(RELATIONSHIP_WRITE_REPOSITORY_PORT)
    private readonly repo: RelationshipWriteRepositoryPort,
  ) {}

  async changeManager(
    actorId: string,
    subjectUserId: string,
    newHolderId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    this.assertNoSelfAssignment(actorId, newHolderId);
    return this.repo.replaceRelationship(
      'manager',
      actorId,
      subjectUserId,
      newHolderId,
      expectedCurrent,
    );
  }

  async changePeoplePartner(
    actorId: string,
    subjectUserId: string,
    newHolderId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    this.assertNoSelfAssignment(actorId, newHolderId);
    return this.repo.replaceRelationship(
      'people_partner',
      actorId,
      subjectUserId,
      newHolderId,
      expectedCurrent,
    );
  }

  async changeDepartment(
    actorId: string,
    subjectUserId: string,
    newDepartmentId: string,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    return this.repo.changeDepartment(
      actorId,
      subjectUserId,
      newDepartmentId,
      expectedCurrent,
    );
  }

  async changeDepartmentManager(
    actorId: string,
    departmentId: string,
    newManagerId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    this.assertNoSelfAssignment(actorId, newManagerId);
    return this.repo.changeDepartmentManager(
      actorId,
      departmentId,
      newManagerId,
      expectedCurrent,
    );
  }

  userExists(userId: string): Promise<boolean> {
    return this.repo.userExists(userId);
  }

  departmentExists(departmentId: string): Promise<boolean> {
    return this.repo.departmentExists(departmentId);
  }

  private assertNoSelfAssignment(
    actorId: string,
    newHolderId: string | null,
  ): void {
    if (newHolderId !== null && newHolderId === actorId) {
      // AD-8: rejected before any repository call — no relationship or
      // journal row is ever attempted, let alone committed.
      throw new SelfAssignmentError();
    }
  }
}
