import { ConflictException, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type Relationship } from '../../generated/prisma/client';
import type {
  AddDepartmentMembershipCommand,
  AddDepartmentMembershipResult,
  AssignManagerCommand,
  ChangePeoplePartnerCommand,
  ChangePeoplePartnerResult,
  DepartmentManagerContext,
  ManagerEdgeSnapshot,
  OrgRelationshipWriterPort,
  PeoplePartnerEdgeSnapshot,
  RemoveDepartmentManagerCommand,
  RemoveDepartmentManagerResult,
  RemoveDepartmentMembershipCommand,
  RemoveDepartmentMembershipResult,
  RemovePeoplePartnerCommand,
  RemovePeoplePartnerResult,
  RevokeManagerCommand,
  SetDepartmentManagerCommand,
  SetDepartmentManagerResult,
} from '../domain/interfaces/org-relationship-writer.port';
import { accessJournalIdempotencyKey } from './access-journal-idempotency';

/** The interactive-transaction client type (same derivation as
 *  `population-import.repository.ts`). */
type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

// Thrown inside a `people_partner` `$transaction` when the optimistic predicate
// no longer holds (a concurrent writer moved or removed the edge first). Caught
// at the method boundary and turned into a `stale` / `not-found` outcome — the
// throw rolls the whole transaction back, so no journal row is left behind.
class StalePeoplePartnerPredicate extends Error {}

// Thrown inside a department-membership `$transaction` when a named-source move
// finds no current membership to close (a concurrent move got there first, or
// the client named the wrong source). Rolls the whole transaction back.
class StaleDepartmentSource extends Error {}

/** Today's calendar date in UTC — the `@db.Date` columns
 *  (`DepartmentMembership.validFrom/validTo`, `UserEvent.eventDate`) store a
 *  date only. Mirrors `CareerTimelineService` ("в UTC, як і інші всі дати"). */
function todayUtcDate(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

// Story 4.1 — the production binding for `ORG_RELATIONSHIP_WRITER_PORT`. Every
// `direct` (reports-to) edge write and its one `AccessJournal` row
// (`kind: 'manager'`) commit in a single `prisma.$transaction` (AD-11: an
// explicit synchronous co-write, no event bus). The DB partial UNIQUE
// `relationships_one_direct_per_user` — never an app pre-check — is the arbiter
// of "one manager per employee" (DEC-UM-005); a losing insert's P2002 aborts the
// whole transaction, so no journal row is left behind.
@Injectable()
export class OrgRelationshipRepository implements OrgRelationshipWriterPort {
  constructor(private readonly prisma: PrismaService) {}

  async assignManager(command: AssignManagerCommand): Promise<Relationship> {
    const { subjectId, targetId, actorId } = command;
    // The edge id is generated here so it can be embedded in the journal `after`
    // snapshot and the idempotency key within the same transaction.
    const relationshipId = uuidv7();
    const snapshot: ManagerEdgeSnapshot = {
      relationshipId,
      userId: subjectId,
      type: 'direct',
      reportsToUserId: targetId,
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.relationship.create({
          data: {
            id: relationshipId,
            userId: subjectId,
            type: 'direct',
            reportsToUserId: targetId,
          },
        });

        await tx.accessJournal.createMany({
          data: [
            {
              id: uuidv7(),
              actorUserId: actorId,
              subjectUserId: subjectId,
              kind: 'manager',
              before: Prisma.DbNull,
              after: snapshot as unknown as Prisma.InputJsonValue,
              idempotencyKey: accessJournalIdempotencyKey(
                actorId,
                subjectId,
                'manager',
                relationshipId,
                'create',
              ),
            },
          ],
          // `ON CONFLICT DO NOTHING` on the unique `idempotencyKey` — one row
          // wins if the same fact transition is ever reached twice.
          skipDuplicates: true,
        });

        return created;
      });
    } catch (error) {
      throw this.mapKnownError(error);
    }
  }

  async revokeManager(command: RevokeManagerCommand): Promise<boolean> {
    const { subjectId, relationshipId, actorId } = command;

    // Scoped lookup outside the transaction: an unknown id, a cross-employee id,
    // and a non-`direct` id all collapse to `null` → the action returns one 404.
    const existing = await this.prisma.relationship.findFirst({
      where: { id: relationshipId, userId: subjectId, type: 'direct' },
    });
    if (!existing || existing.reportsToUserId === null) {
      return false;
    }

    const snapshot: ManagerEdgeSnapshot = {
      relationshipId: existing.id,
      userId: subjectId,
      type: 'direct',
      reportsToUserId: existing.reportsToUserId,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.relationship.delete({ where: { id: relationshipId } });
        await tx.accessJournal.createMany({
          data: [
            {
              id: uuidv7(),
              actorUserId: actorId,
              subjectUserId: subjectId,
              kind: 'manager',
              before: snapshot as unknown as Prisma.InputJsonValue,
              after: Prisma.DbNull,
              idempotencyKey: accessJournalIdempotencyKey(
                actorId,
                subjectId,
                'manager',
                relationshipId,
                'delete',
              ),
            },
          ],
          skipDuplicates: true,
        });
      });
    } catch (error) {
      // A concurrent double-revoke: the row is already gone (P2025). Treat it as
      // "nothing to revoke" — the action turns that into a 404, not a 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return false;
      }
      throw error;
    }

    return true;
  }

  async changePeoplePartner(
    command: ChangePeoplePartnerCommand,
  ): Promise<ChangePeoplePartnerResult> {
    const { subjectId, targetId, expectedCurrentTargetId, actorId } = command;

    // Load the current PP edge; the create-vs-replace-vs-stale decision is made
    // from it plus the optimistic token (DEC-UM-005 does NOT apply here — the
    // `people_partner` edge is an atomic create-or-replace, not DELETE-then-POST).
    const current = await this.prisma.relationship.findFirst({
      where: { userId: subjectId, type: 'people_partner' },
    });

    if (!current || current.reportsToUserId === null) {
      if (expectedCurrentTargetId !== undefined) {
        // A token was supplied but there is no current PP to match — stale.
        return { outcome: 'stale' };
      }
      return this.createPeoplePartner(subjectId, targetId, actorId);
    }

    if (
      expectedCurrentTargetId === undefined ||
      expectedCurrentTargetId !== current.reportsToUserId
    ) {
      // Blind replace (token omitted while a PP exists), or a token that no
      // longer matches the current PP — both are `409`.
      return { outcome: 'stale' };
    }

    return this.replacePeoplePartner(
      subjectId,
      targetId,
      current.reportsToUserId,
      current.id,
      actorId,
    );
  }

  async removePeoplePartner(
    command: RemovePeoplePartnerCommand,
  ): Promise<RemovePeoplePartnerResult> {
    const { subjectId, expectedCurrentTargetId, actorId } = command;

    const current = await this.prisma.relationship.findFirst({
      where: { userId: subjectId, type: 'people_partner' },
    });
    if (!current || current.reportsToUserId === null) {
      return { outcome: 'not-found' };
    }
    const currentTargetId = current.reportsToUserId;
    if (
      expectedCurrentTargetId !== undefined &&
      expectedCurrentTargetId !== currentTargetId
    ) {
      return { outcome: 'stale' };
    }

    const before: PeoplePartnerEdgeSnapshot = {
      relationshipId: current.id,
      userId: subjectId,
      type: 'people_partner',
      reportsToUserId: currentTargetId,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        const deleted = await tx.relationship.deleteMany({
          where: {
            userId: subjectId,
            type: 'people_partner',
            reportsToUserId: currentTargetId,
          },
        });
        if (deleted.count !== 1) {
          // A concurrent delete already removed the edge.
          throw new StalePeoplePartnerPredicate();
        }
        await tx.accessJournal.createMany({
          data: [
            {
              id: uuidv7(),
              actorUserId: actorId,
              subjectUserId: subjectId,
              kind: 'people_partner',
              before: before as unknown as Prisma.InputJsonValue,
              after: Prisma.DbNull,
              idempotencyKey: accessJournalIdempotencyKey(
                actorId,
                subjectId,
                'people_partner',
                current.id,
                'delete',
              ),
            },
          ],
          skipDuplicates: true,
        });
      });
    } catch (error) {
      if (error instanceof StalePeoplePartnerPredicate) {
        return { outcome: 'not-found' };
      }
      throw error;
    }

    return { outcome: 'removed' };
  }

  private async createPeoplePartner(
    subjectId: string,
    targetId: string,
    actorId: string,
  ): Promise<ChangePeoplePartnerResult> {
    const relationshipId = uuidv7();
    const after: PeoplePartnerEdgeSnapshot = {
      relationshipId,
      userId: subjectId,
      type: 'people_partner',
      reportsToUserId: targetId,
    };

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.relationship.create({
          data: {
            id: relationshipId,
            userId: subjectId,
            type: 'people_partner',
            reportsToUserId: targetId,
          },
        });
        await tx.accessJournal.createMany({
          data: [
            {
              id: uuidv7(),
              actorUserId: actorId,
              subjectUserId: subjectId,
              kind: 'people_partner',
              before: Prisma.DbNull,
              after: after as unknown as Prisma.InputJsonValue,
              idempotencyKey: accessJournalIdempotencyKey(
                actorId,
                subjectId,
                'people_partner',
                relationshipId,
                'create',
              ),
            },
          ],
          skipDuplicates: true,
        });
        return row;
      });
      return { outcome: 'assigned', relationship: created };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // A concurrent first-assignment won the partial-unique race.
        return { outcome: 'stale' };
      }
      throw error;
    }
  }

  private async replacePeoplePartner(
    subjectId: string,
    targetId: string,
    currentTargetId: string,
    currentRelationshipId: string,
    actorId: string,
  ): Promise<ChangePeoplePartnerResult> {
    const relationshipId = uuidv7();
    const before: PeoplePartnerEdgeSnapshot = {
      relationshipId: currentRelationshipId,
      userId: subjectId,
      type: 'people_partner',
      reportsToUserId: currentTargetId,
    };
    const after: PeoplePartnerEdgeSnapshot = {
      relationshipId,
      userId: subjectId,
      type: 'people_partner',
      reportsToUserId: targetId,
    };

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Conditional hard delete (AD-11): the predicate `(userId, type,
        // reportsToUserId = expected)` is the compare-and-swap. A concurrent
        // replace that already moved the edge makes this affect 0 rows → abort.
        const deleted = await tx.relationship.deleteMany({
          where: {
            userId: subjectId,
            type: 'people_partner',
            reportsToUserId: currentTargetId,
          },
        });
        if (deleted.count !== 1) {
          throw new StalePeoplePartnerPredicate();
        }
        const row = await tx.relationship.create({
          data: {
            id: relationshipId,
            userId: subjectId,
            type: 'people_partner',
            reportsToUserId: targetId,
          },
        });
        await tx.accessJournal.createMany({
          data: [
            {
              id: uuidv7(),
              actorUserId: actorId,
              subjectUserId: subjectId,
              kind: 'people_partner',
              before: before as unknown as Prisma.InputJsonValue,
              after: after as unknown as Prisma.InputJsonValue,
              idempotencyKey: accessJournalIdempotencyKey(
                actorId,
                subjectId,
                'people_partner',
                relationshipId,
                'replace',
              ),
            },
          ],
          skipDuplicates: true,
        });
        return row;
      });
      return { outcome: 'assigned', relationship: created };
    } catch (error) {
      if (error instanceof StalePeoplePartnerPredicate) {
        return { outcome: 'stale' };
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { outcome: 'stale' };
      }
      throw error;
    }
  }

  private mapKnownError(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // The `direct` edge already exists (DEC-UM-005): reassignment is an
      // explicit DELETE then POST, never an implicit replace.
      return new ConflictException(
        'this employee already has a reports-to manager; revoke it first',
      );
    }
    return error;
  }

  // === Story 4.3 — department membership ===================================

  async loadDepartmentManagerContext(
    deptId: string,
  ): Promise<DepartmentManagerContext> {
    const department = await this.prisma.department.findUnique({
      where: { id: deptId },
      select: { id: true },
    });
    if (!department) {
      return { departmentExists: false, currentManagerUserId: null };
    }
    const link = await this.prisma.userPolicy.findFirst({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: deptId,
          targetRole: 'unit-manager',
        },
      },
      select: { userId: true },
    });
    return {
      departmentExists: true,
      currentManagerUserId: link?.userId ?? null,
    };
  }

  async addOrMoveDepartmentMembership(
    command: AddDepartmentMembershipCommand,
  ): Promise<AddDepartmentMembershipResult> {
    const { subjectId, departmentId, fromDepartmentId, actorId } = command;

    const target = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true },
    });
    if (!target) {
      return { outcome: 'department-not-found' };
    }

    const today = todayUtcDate();

    if (fromDepartmentId !== undefined) {
      try {
        const membership = await this.prisma.$transaction(async (tx) => {
          const closed = await tx.departmentMembership.updateMany({
            where: {
              userId: subjectId,
              departmentId: fromDepartmentId,
              validTo: null,
            },
            data: { validTo: today },
          });
          if (closed.count === 0) {
            throw new StaleDepartmentSource();
          }
          const created = await tx.departmentMembership.create({
            data: { userId: subjectId, departmentId, validFrom: today },
          });
          await this.writeDepartmentChangeEvent(
            tx,
            subjectId,
            departmentId,
            actorId,
            today,
            false,
          );
          await this.writeMembershipJournal(
            tx,
            actorId,
            subjectId,
            created.id,
            { departmentId: fromDepartmentId },
            { departmentId },
            'dept_move',
          );
          return created;
        });
        return { outcome: 'added', membership };
      } catch (error) {
        if (error instanceof StaleDepartmentSource) {
          return { outcome: 'stale-source' };
        }
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // The move target is already a current membership.
          return { outcome: 'already-member' };
        }
        throw error;
      }
    }

    // Plain add — the employee keeps every existing current membership.
    const existing = await this.prisma.departmentMembership.findFirst({
      where: { userId: subjectId, departmentId, validTo: null },
    });
    if (existing) {
      return { outcome: 'already-member' };
    }
    try {
      const membership = await this.prisma.$transaction(async (tx) => {
        const created = await tx.departmentMembership.create({
          data: { userId: subjectId, departmentId, validFrom: today },
        });
        await this.writeDepartmentChangeEvent(
          tx,
          subjectId,
          departmentId,
          actorId,
          today,
          false,
        );
        await this.writeMembershipJournal(
          tx,
          actorId,
          subjectId,
          created.id,
          null,
          { departmentId },
          'dept_add',
        );
        return created;
      });
      return { outcome: 'added', membership };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { outcome: 'already-member' };
      }
      throw error;
    }
  }

  async removeDepartmentMembership(
    command: RemoveDepartmentMembershipCommand,
  ): Promise<RemoveDepartmentMembershipResult> {
    const { subjectId, departmentId, actorId } = command;

    const current = await this.prisma.departmentMembership.findMany({
      where: { userId: subjectId, validTo: null },
    });
    const targetRow = current.find((m) => m.departmentId === departmentId);
    if (!targetRow) {
      return { outcome: 'not-found' };
    }
    if (current.length === 1) {
      return { outcome: 'last-membership' };
    }

    const today = todayUtcDate();
    await this.prisma.$transaction(async (tx) => {
      await tx.departmentMembership.update({
        where: { id: targetRow.id },
        data: { validTo: today },
      });
      await this.writeDepartmentChangeEvent(
        tx,
        subjectId,
        departmentId,
        actorId,
        today,
        true,
      );
      await this.writeMembershipJournal(
        tx,
        actorId,
        subjectId,
        targetRow.id,
        { departmentId },
        null,
        'dept_remove',
      );
    });
    return { outcome: 'removed' };
  }

  // === Story 4.3 — department manager =====================================

  async setDepartmentManager(
    command: SetDepartmentManagerCommand,
  ): Promise<SetDepartmentManagerResult> {
    const { deptId, managerUserId, expectedCurrentManagerId, actorId } =
      command;

    return this.prisma.$transaction(
      async (tx): Promise<SetDepartmentManagerResult> => {
        const policy = await tx.policy.findFirst({
          where: {
            type: 'AR',
            targetType: 'department',
            targetId: deptId,
            targetRole: 'unit-manager',
          },
        });
        const currentLink = policy
          ? await tx.userPolicy.findFirst({ where: { policyId: policy.id } })
          : null;
        const currentManagerUserId = currentLink?.userId ?? null;

        // Optimistic-concurrency contract (mirrors the people-partner edge):
        //  - token supplied but no current manager        → stale
        //  - current manager exists but token omitted      → stale (blind replace)
        //  - token supplied and does not match the current → stale
        if (currentManagerUserId === null) {
          if (expectedCurrentManagerId !== undefined) {
            return { outcome: 'stale' };
          }
        } else if (
          expectedCurrentManagerId === undefined ||
          expectedCurrentManagerId !== currentManagerUserId
        ) {
          return { outcome: 'stale' };
        }

        const policyRow =
          policy ??
          (await tx.policy.create({
            data: {
              operator: '==',
              targetType: 'department',
              targetId: deptId,
              targetRole: 'unit-manager',
              type: 'AR',
              managedBy: 'admin',
            },
          }));

        // Repoint the link: at most one manager per department (keep the single
        // `Policies` row, swap the `UserPolicies` link).
        await tx.userPolicy.deleteMany({ where: { policyId: policyRow.id } });
        await tx.userPolicy.create({
          data: { userId: managerUserId, policyId: policyRow.id },
        });

        await this.writeManagerJournal(
          tx,
          actorId,
          deptId,
          policyRow.id,
          managerUserId,
          currentManagerUserId === null
            ? null
            : { managerUserId: currentManagerUserId },
          { managerUserId },
          'dept_mgr_set',
        );
        return { outcome: 'set' };
      },
    );
  }

  async removeDepartmentManager(
    command: RemoveDepartmentManagerCommand,
  ): Promise<RemoveDepartmentManagerResult> {
    const { deptId, actorId } = command;

    const policy = await this.prisma.policy.findFirst({
      where: {
        type: 'AR',
        targetType: 'department',
        targetId: deptId,
        targetRole: 'unit-manager',
      },
    });
    const currentLink = policy
      ? await this.prisma.userPolicy.findFirst({
          where: { policyId: policy.id },
        })
      : null;
    if (!policy || !currentLink) {
      return { outcome: 'not-found' };
    }
    const managerUserId = currentLink.userId;

    await this.prisma.$transaction(async (tx) => {
      // Keep the `Policies` row (a later re-assign repoints it); drop the link.
      await tx.userPolicy.deleteMany({ where: { policyId: policy.id } });
      await this.writeManagerJournal(
        tx,
        actorId,
        deptId,
        policy.id,
        managerUserId,
        { managerUserId },
        null,
        'dept_mgr_remove',
      );
    });
    return { outcome: 'removed' };
  }

  // --- shared write helpers ----------------------------------------------

  private async writeDepartmentChangeEvent(
    tx: PrismaTx,
    userId: string,
    departmentId: string,
    actorId: string,
    eventDate: Date,
    removed: boolean,
  ): Promise<void> {
    await tx.userEvent.create({
      data: {
        userId,
        type: 'department_change',
        eventDate,
        details: removed
          ? { department: departmentId, removed: true }
          : { department: departmentId },
        source: 'system',
        createdBy: actorId,
      },
    });
  }

  private async writeMembershipJournal(
    tx: PrismaTx,
    actorId: string,
    subjectId: string,
    membershipId: string,
    before: { departmentId: string } | null,
    after: { departmentId: string } | null,
    operation: 'dept_add' | 'dept_move' | 'dept_remove',
  ): Promise<void> {
    await tx.accessJournal.createMany({
      data: [
        {
          id: uuidv7(),
          actorUserId: actorId,
          subjectUserId: subjectId,
          kind: 'department_membership',
          before:
            before === null
              ? Prisma.DbNull
              : (before as unknown as Prisma.InputJsonValue),
          after:
            after === null
              ? Prisma.DbNull
              : (after as unknown as Prisma.InputJsonValue),
          idempotencyKey: accessJournalIdempotencyKey(
            actorId,
            subjectId,
            'department_membership',
            membershipId,
            operation,
          ),
        },
      ],
      skipDuplicates: true,
    });
  }

  private async writeManagerJournal(
    tx: PrismaTx,
    actorId: string,
    deptId: string,
    policyId: string,
    managerUserId: string,
    before: { managerUserId: string } | null,
    after: { managerUserId: string } | null,
    operation: 'dept_mgr_set' | 'dept_mgr_remove',
  ): Promise<void> {
    await tx.accessJournal.createMany({
      data: [
        {
          id: uuidv7(),
          actorUserId: actorId,
          // The subject of a department-manager change is the department, not a
          // user (the `story_4_3` migration made `subjectUserId` nullable and
          // added `subjectDepartmentId` + a one-subject CHECK).
          subjectUserId: null,
          subjectDepartmentId: deptId,
          kind: 'department_manager',
          before:
            before === null
              ? Prisma.DbNull
              : (before as unknown as Prisma.InputJsonValue),
          after:
            after === null
              ? Prisma.DbNull
              : (after as unknown as Prisma.InputJsonValue),
          idempotencyKey: accessJournalIdempotencyKey(
            actorId,
            deptId,
            'department_manager',
            `${policyId}:${managerUserId}`,
            operation,
          ),
        },
      ],
      skipDuplicates: true,
    });
  }
}
