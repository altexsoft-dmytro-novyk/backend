import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PopulationImportRowError,
  type ParsedImportRow,
  type PopulationImportRepositoryPort,
  type RowWriteResult,
} from '../domain/interfaces/population-import.repository.port';

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * Story 1.1 — the Prisma-backed transactional writer for one import row.
 *
 * Each `writeRow` runs in a single interactive transaction (`um-seed-13`
 * all-or-nothing per row): the `Department` upsert, the `User` insert/update,
 * the `DepartmentMembership`, the `EmploymentStatus`, and — for a NEW user — the
 * `joined_company` `UserEvent` all commit together or not at all.
 *
 * Idempotency (`um-seed-08`): matched by the normalized `workEmail`, an existing
 * row is updated in place (import-owned columns only — never `photo` /
 * `customFields` / `ttId`); its single current `DepartmentMembership` /
 * `EmploymentStatus` are refreshed in place; no duplicate `joined_company`
 * event is written.
 */
@Injectable()
export class PopulationImportRepository implements PopulationImportRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  writeRow(row: ParsedImportRow, operatorId: string): Promise<RowWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const departmentResult = await this.upsertDepartment(tx, row);
      const departmentId = departmentResult.id;

      // Ambiguity guard: more than one existing row normalizing to this key
      // (only possible from legacy non-normalized data) is skipped, never
      // silently resolved (seed README "never silently pick one").
      const matches = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM users WHERE lower(trim("workEmail")) = $1 FOR UPDATE`,
        row.workEmail,
      );
      if (matches.length > 1) {
        throw new PopulationImportRowError(
          `ambiguous existing users for this email: ${matches
            .map((m) => m.id)
            .join(', ')}`,
        );
      }

      if (matches.length === 1) {
        const userId = matches[0].id;
        await tx.user.update({
          where: { id: userId },
          // Import-owned columns only (decision 12).
          data: {
            firstName: row.firstName,
            lastName: row.lastName,
            workEmail: row.workEmail,
            position: row.position,
            country: row.country,
            birthDay: row.birthDay,
            birthMonth: row.birthMonth,
            companyJoinDate: row.companyJoinDate,
          },
        });
        await this.syncMembership(
          tx,
          userId,
          departmentId,
          row.companyJoinDate,
        );
        await this.syncEmploymentStatus(tx, userId, row);
        return {
          outcome: 'updated',
          departmentCreated: departmentResult.created,
        };
      }

      const user = await tx.user.create({
        data: {
          firstName: row.firstName,
          lastName: row.lastName,
          workEmail: row.workEmail,
          position: row.position,
          country: row.country,
          city: null,
          workPhone: null,
          photo: null,
          birthDay: row.birthDay,
          birthMonth: row.birthMonth,
          companyJoinDate: row.companyJoinDate,
          isActive: true,
          createdBy: operatorId,
          // customFields left to the DB default '{}' (DEC-UM-003).
        },
      });

      await tx.departmentMembership.create({
        data: {
          userId: user.id,
          departmentId,
          validFrom: row.companyJoinDate,
        },
      });
      await tx.employmentStatus.create({
        data: {
          userId: user.id,
          status: row.employment.status,
          validFrom: row.employment.validFrom,
        },
      });
      await tx.userEvent.create({
        data: {
          userId: user.id,
          type: 'joined_company',
          eventDate: row.companyJoinDate,
          source: 'system',
          createdBy: operatorId,
        },
      });

      return {
        outcome: 'created',
        departmentCreated: departmentResult.created,
      };
    });
  }

  /** Create-on-import keyed by the `(externalId, name)` pair — the same
   *  `DepartmentId` with a divergent name is a distinct department. */
  private async upsertDepartment(
    tx: PrismaTx,
    row: ParsedImportRow,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await tx.department.findFirst({
      where: {
        externalId: row.department.externalId,
        name: row.department.name,
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    const created = await tx.department.create({
      data: {
        externalId: row.department.externalId,
        name: row.department.name,
        // parentId null on import — hierarchy is assigned later.
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }

  /** Exactly one current (`validTo IS NULL`) membership per user. Same
   *  department → no-op; a moved user → the single current row is updated in
   *  place (decision 9 — no `department_change` in Story 1.1). */
  private async syncMembership(
    tx: PrismaTx,
    userId: string,
    departmentId: string,
    validFrom: Date,
  ): Promise<void> {
    const current = await tx.departmentMembership.findFirst({
      where: { userId, validTo: null },
    });
    if (!current) {
      await tx.departmentMembership.create({
        data: { userId, departmentId, validFrom },
      });
      return;
    }
    if (current.departmentId === departmentId) return;
    await tx.departmentMembership.update({
      where: { id: current.id },
      data: { departmentId, validFrom },
    });
  }

  /** Exactly one current employment-status row per user, refreshed in place. */
  private async syncEmploymentStatus(
    tx: PrismaTx,
    userId: string,
    row: ParsedImportRow,
  ): Promise<void> {
    const current = await tx.employmentStatus.findFirst({
      where: { userId, validTo: null },
    });
    if (!current) {
      await tx.employmentStatus.create({
        data: {
          userId,
          status: row.employment.status,
          validFrom: row.employment.validFrom,
        },
      });
      return;
    }
    await tx.employmentStatus.update({
      where: { id: current.id },
      data: {
        status: row.employment.status,
        validFrom: row.employment.validFrom,
        departureReason: null,
        sourceDepartureId: null,
      },
    });
  }
}
