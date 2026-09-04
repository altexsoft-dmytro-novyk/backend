import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Prisma,
  type AccessJournalKind,
  type Departure,
} from '../../generated/prisma/client';
import type {
  CreateDepartureInput,
  CreateDepartureResult,
  DepartureRecord,
  DepartureRepositoryPort,
  PlatformBlockerSet,
  ReparentCommand,
  ReparentResult,
} from '../domain/interfaces/departure.repository.port';
import { computeExpectedBlockerVersion } from '../domain/services/departure.rules';
import { accessJournalIdempotencyKey } from './access-journal-idempotency';
import { coerceIdempotencyKeyToUuid } from './departure-idempotency';

/** Either the base client or an interactive-transaction client. */
type Client = PrismaService | Prisma.TransactionClient;

// Thrown inside the re-parent `$transaction` when the recomputed blocker digest
// no longer matches the caller's `expectedBlockerVersion`. Caught at the method
// boundary and turned into `{ outcome: 'stale' }` — the throw rolls the whole
// transaction back, so nothing is reassigned and no journal row is left behind.
class StaleBlockerDigest extends Error {}

// Story 5.1 — the production binding for `DEPARTURE_REPOSITORY_PORT`.
//
// The re-parent transaction re-implements the three edge/link + `AccessJournal`
// writes inline (rule-6 fallback): threading an optional `tx` through Epic 4's
// `org-relationship.repository.ts` write methods + port + service delegators is
// the more invasive change and risks the Epic 4 suite, so the contained
// duplication is the lower-risk option. The journal rows use the same
// `accessJournalIdempotencyKey` helper and the same `kind` values Epic 4 emits.
@Injectable()
export class DepartureRepository implements DepartureRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async loadPlatformBlockers(userId: string): Promise<PlatformBlockerSet> {
    return this.loadPlatformBlockersOn(this.prisma, userId);
  }

  async findByIdempotencyKey(rawKey: string): Promise<DepartureRecord | null> {
    const row = await this.prisma.departure.findUnique({
      where: { idempotencyKey: coerceIdempotencyKeyToUuid(rawKey) },
    });
    return row ? toRecord(row) : null;
  }

  async findNonAppliedByUser(userId: string): Promise<DepartureRecord | null> {
    const row = await this.prisma.departure.findFirst({
      where: { userId, state: { not: 'applied' } },
    });
    return row ? toRecord(row) : null;
  }

  async findByIdForUser(
    userId: string,
    departureId: string,
  ): Promise<DepartureRecord | null> {
    const row = await this.prisma.departure.findFirst({
      where: { id: departureId, userId },
    });
    return row ? toRecord(row) : null;
  }

  async create(input: CreateDepartureInput): Promise<CreateDepartureResult> {
    const idempotencyKey = coerceIdempotencyKeyToUuid(input.idempotencyKey);
    try {
      const row = await this.prisma.departure.create({
        data: {
          userId: input.userId,
          effectiveDate: new Date(
            `${input.effectiveDate.slice(0, 10)}T00:00:00.000Z`,
          ),
          effectiveTimeZone: input.effectiveTimeZone,
          dueAt: input.dueAt,
          reason: input.reason,
          state: 'scheduled',
          idempotencyKey,
          requestHash: input.requestHash,
          createdBy: input.createdBy,
        },
      });
      return { outcome: 'created', record: toRecord(row) };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = JSON.stringify(error.meta?.target ?? '');
        if (target.includes('idempotencyKey')) {
          // A concurrent insert won the `idempotencyKey` race.
          const existing = await this.prisma.departure.findUnique({
            where: { idempotencyKey },
          });
          if (existing && existing.requestHash === input.requestHash) {
            return {
              outcome: 'idempotency_replay',
              record: toRecord(existing),
            };
          }
          return { outcome: 'idempotency_mismatch' };
        }
        // `departures_one_non_applied_per_user` — a non-applied Departure already
        // exists for this user under a different key.
        return { outcome: 'already_scheduled' };
      }
      throw error;
    }
  }

  async hasNonAppliedDeparture(userId: string): Promise<boolean> {
    const count = await this.prisma.departure.count({
      where: { userId, state: { not: 'applied' } },
    });
    return count > 0;
  }

  async reparentPlatformBlockers(
    command: ReparentCommand,
  ): Promise<ReparentResult> {
    const { userId, targetId, actorId, expectedBlockerVersion } = command;
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent re-parents for the same departing user, so the
        // digest recheck below sees a stable blocker set (um-dep-05 T5).
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `departure-reparent:${userId}`,
        );

        const set = await this.loadPlatformBlockersOn(tx, userId);
        if (
          computeExpectedBlockerVersion(userId, set) !== expectedBlockerVersion
        ) {
          throw new StaleBlockerDigest();
        }

        for (const report of set.directReports) {
          const before = {
            relationshipId: report.relationshipId,
            userId: report.reportUserId,
            type: 'direct',
            reportsToUserId: userId,
          };
          await tx.relationship.update({
            where: { id: report.relationshipId },
            data: { reportsToUserId: targetId },
          });
          await writeReparentJournal(
            tx,
            actorId,
            report.reportUserId,
            null,
            'manager',
            before,
            { ...before, reportsToUserId: targetId },
            report.relationshipId,
            'replace',
          );
        }

        for (const pp of set.peoplePartnerAssignments) {
          const before = {
            relationshipId: pp.relationshipId,
            userId: pp.partneredUserId,
            type: 'people_partner',
            reportsToUserId: userId,
          };
          await tx.relationship.update({
            where: { id: pp.relationshipId },
            data: { reportsToUserId: targetId },
          });
          await writeReparentJournal(
            tx,
            actorId,
            pp.partneredUserId,
            null,
            'people_partner',
            before,
            { ...before, reportsToUserId: targetId },
            pp.relationshipId,
            'replace',
          );
        }

        let departmentManager = false;
        if (set.departmentManager) {
          const { policyId, departmentId } = set.departmentManager;
          await tx.userPolicy.deleteMany({ where: { policyId, userId } });
          await tx.userPolicy.create({
            data: { userId: targetId, policyId },
          });
          departmentManager = true;
          await writeReparentJournal(
            tx,
            actorId,
            null,
            departmentId,
            'department_manager',
            { managerUserId: userId },
            { managerUserId: targetId },
            `${policyId}:${targetId}`,
            'dept_mgr_set',
          );
        }

        return {
          outcome: 'reassigned' as const,
          counts: {
            directReports: set.directReports.length,
            departmentManager,
            peoplePartnerAssignments: set.peoplePartnerAssignments.length,
          },
        };
      });
    } catch (error) {
      if (error instanceof StaleBlockerDigest) {
        return { outcome: 'stale' };
      }
      throw error;
    }
  }

  private async loadPlatformBlockersOn(
    client: Client,
    userId: string,
  ): Promise<PlatformBlockerSet> {
    const [directReportRows, ppRows, deptPolicy, ownManagerEdge] =
      await Promise.all([
        client.relationship.findMany({
          where: { type: 'direct', reportsToUserId: userId },
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        }),
        client.relationship.findMany({
          where: { type: 'people_partner', reportsToUserId: userId },
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        }),
        client.policy.findFirst({
          where: {
            type: 'AR',
            targetType: 'department',
            targetRole: 'unit-manager',
            userPolicies: { some: { userId } },
          },
        }),
        client.relationship.findFirst({
          where: { type: 'direct', userId },
          select: { reportsToUserId: true },
        }),
      ]);

    let departmentManager: PlatformBlockerSet['departmentManager'] = null;
    if (deptPolicy?.targetId) {
      const dept = await client.department.findUnique({
        where: { id: deptPolicy.targetId },
        select: { name: true },
      });
      departmentManager = {
        policyId: deptPolicy.id,
        departmentId: deptPolicy.targetId,
        departmentName: dept?.name ?? deptPolicy.targetId,
      };
    }

    return {
      directReports: directReportRows.map((row) => ({
        relationshipId: row.id,
        reportUserId: row.userId,
        reportName: fullName(row.user),
      })),
      peoplePartnerAssignments: ppRows.map((row) => ({
        relationshipId: row.id,
        partneredUserId: row.userId,
        partneredName: fullName(row.user),
      })),
      departmentManager,
      ownDirectManagerId: ownManagerEdge?.reportsToUserId ?? null,
    };
  }
}

function fullName(user: { firstName: string; lastName: string }): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

function toRecord(row: Departure): DepartureRecord {
  return {
    id: row.id,
    userId: row.userId,
    state: row.state,
    effectiveDate: row.effectiveDate,
    effectiveTimeZone: row.effectiveTimeZone,
    dueAt: row.dueAt,
    reason: row.reason,
    requestHash: row.requestHash,
    attempts: row.attempts,
    lastError: row.lastError,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
  };
}

async function writeReparentJournal(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  subjectUserId: string | null,
  subjectDepartmentId: string | null,
  kind: AccessJournalKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ref: string,
  operation: 'replace' | 'dept_mgr_set',
): Promise<void> {
  const subjectKey = subjectUserId ?? subjectDepartmentId ?? actorUserId;
  await tx.accessJournal.createMany({
    data: [
      {
        id: uuidv7(),
        actorUserId,
        subjectUserId,
        subjectDepartmentId,
        kind,
        before: before as unknown as Prisma.InputJsonValue,
        after: after as unknown as Prisma.InputJsonValue,
        idempotencyKey: accessJournalIdempotencyKey(
          actorUserId,
          subjectKey,
          kind,
          ref,
          operation,
        ),
      },
    ],
    skipDuplicates: true,
  });
}
