import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  RelationshipWriteRepositoryPort,
  RelationshipWriteResult,
} from '../domain/interfaces/relationship-write-repository.port';

type TxClient = Prisma.TransactionClient;

const RELATIONSHIP_TYPE_BY_FIELD = {
  manager: 'direct',
  people_partner: 'people_partner',
} as const;

// AD-5/AD-6: every write here locks the row(s) it changes with a raw
// `SELECT ... FOR UPDATE` inside the same transaction as the compare,
// mutation, and AD-7 journal insert — the CAS contract the spine requires.
// `expectedCurrent` is optional: omitted, the write proceeds unconditionally
// (still transactionally safe, just not CAS-guarded); supplied, a mismatch
// against the locked current value rolls the transaction back and reports
// 'conflict' rather than silently overwriting a concurrent change.
@Injectable()
export class RelationshipWriteRepository implements RelationshipWriteRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async replaceRelationship(
    field: 'manager' | 'people_partner',
    actorId: string,
    subjectUserId: string,
    newHolderId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    const type = RELATIONSHIP_TYPE_BY_FIELD[field];
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; holder_user_id: string }[]>`
        SELECT id, holder_user_id FROM relationships
        WHERE subject_user_id = ${subjectUserId}::uuid
          AND type = ${type}::"RelationshipType"
        FOR UPDATE
      `;
      const currentHolderId = rows[0]?.holder_user_id ?? null;

      if (
        expectedCurrent !== undefined &&
        expectedCurrent !== currentHolderId
      ) {
        return { outcome: 'conflict' } as const;
      }

      if (rows.length > 0) {
        await tx.relationship.delete({ where: { id: rows[0].id } });
      }
      if (newHolderId !== null) {
        await tx.relationship.create({
          data: { type, subjectUserId, holderUserId: newHolderId },
        });
      }

      await this.writeJournal(
        tx,
        actorId,
        subjectUserId,
        field,
        currentHolderId,
        newHolderId,
      );

      return { outcome: 'ok', value: newHolderId } as const;
    });
  }

  async changeDepartment(
    actorId: string,
    subjectUserId: string,
    newDepartmentId: string,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { department_id: string; position: string }[]
      >`
        SELECT department_id, position FROM users
        WHERE id = ${subjectUserId}::uuid
        FOR UPDATE
      `;
      if (rows.length === 0) return { outcome: 'not_found' } as const;
      const currentDepartmentId = rows[0].department_id;

      if (
        expectedCurrent !== undefined &&
        expectedCurrent !== currentDepartmentId
      ) {
        return { outcome: 'conflict' } as const;
      }

      await tx.user.update({
        where: { id: subjectUserId },
        data: { departmentId: newDepartmentId },
      });

      await this.writeJournal(
        tx,
        actorId,
        subjectUserId,
        'department',
        currentDepartmentId,
        newDepartmentId,
      );

      // AD-19: system-generated department_change event, synchronous, in
      // the same transaction as the causing mutation.
      if (currentDepartmentId !== newDepartmentId) {
        await tx.userEvents.create({
          data: {
            userId: subjectUserId,
            type: 'department_change',
            source: 'system',
            eventDate: new Date(),
            details: { from: currentDepartmentId, to: newDepartmentId },
            createdBy: actorId,
          },
        });
      }

      return { outcome: 'ok', value: newDepartmentId } as const;
    });
  }

  async changeDepartmentManager(
    actorId: string,
    departmentId: string,
    newManagerId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ manager_id: string | null }[]>`
        SELECT manager_id FROM departments
        WHERE id = ${departmentId}::uuid
        FOR UPDATE
      `;
      if (rows.length === 0) return { outcome: 'not_found' } as const;
      const currentManagerId = rows[0].manager_id;

      if (
        expectedCurrent !== undefined &&
        expectedCurrent !== currentManagerId
      ) {
        return { outcome: 'conflict' } as const;
      }

      await tx.department.update({
        where: { id: departmentId },
        data: { managerId: newManagerId },
      });

      // AD-7's journal is keyed to a subjectUserId (a User FK) — for a
      // department-manager change there is no natural "subject employee",
      // only the department and the manager being appointed/removed. The
      // spine doesn't spell out this case explicitly (its examples are all
      // person-subject fields); the pragmatic choice made here is to use
      // whichever of after/before manager id is non-null as subjectUserId
      // (the person whose managerial assignment actually changed), since
      // the column is a required FK to `users` and can't reference the
      // department itself.
      const subjectUserId = newManagerId ?? currentManagerId;
      if (subjectUserId) {
        await this.writeJournal(
          tx,
          actorId,
          subjectUserId,
          'department_manager',
          currentManagerId,
          newManagerId,
        );
      }

      return { outcome: 'ok', value: newManagerId } as const;
    });
  }

  async userExists(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }

  async departmentExists(departmentId: string): Promise<boolean> {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true },
    });
    return dept !== null;
  }

  private async writeJournal(
    tx: TxClient,
    actor: string,
    subjectUserId: string,
    fieldType:
      'manager' | 'people_partner' | 'department' | 'department_manager',
    beforeValue: string | null,
    afterValue: string | null,
  ): Promise<void> {
    await tx.relationshipJournal.create({
      data: { actor, subjectUserId, fieldType, beforeValue, afterValue },
    });
  }
}
