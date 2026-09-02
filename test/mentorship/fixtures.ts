import request from 'supertest';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  type TestApp,
} from '../user-management/access-control-adoption/fixtures';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { User } from '../../src/generated/prisma/client';

// ---------------------------------------------------------------------------
// Mentorship bounded context — AD-1 Stage-2 committed-red E2E fixtures.
//
// Binding design: docs/architecture/mentorship.md (draft, routes + aggregate
// shapes fixed). NOTHING is implemented: no src/mentorship/, no MentorshipPair /
// MentorshipAvailability model or table, no `mentorship:assign` permission
// seeded, no career-event boundary (G-CT), no departure executor (G-DEP), no
// `canAccessSection('S13')` (G-S13). Every mentorship route 404s today; every
// `GET /users/:id` mentorship assertion is red on a missing key. That is the
// committed red.
//
// AD-3: real `AppModule`, real Prisma against the migrated `dn-um-2` Postgres,
// NO `overrideProvider`. Reuses `bootstrapTestApp` / `RunFixtures` / `bearer`
// from the Access-Control-Adoption suite.
//
// DEC-UM-010: one worker (`--runInBand`), a collision-proof UUID namespace per
// run (`RunFixtures.runId`), each test deletes only the rows it created.
// Teardown order: mentorship_pairs / mentorship_availability -> user_events ->
// relationships -> policies/permissions -> users -> projects. Every step is
// wrapped so one failure never skips the rest.
// ---------------------------------------------------------------------------

export { RunFixtures, bearer, bootstrapTestApp };
export type { TestApp };

/**
 * The single functional-permission key the §2.2 dual gate checks via the
 * no-target `isAllowed` path (mentorship.md §5.3 / Decision 1; epics.md
 * "assign and end mentorships"). **UNSEEDED** — the Access-Control kernel
 * catalog is `user-management:create|deactivate|list` only (G-PERM), same
 * class as the `user-management:edit` gap. Isolated to this one constant so
 * the day it is seeded there is exactly one place to reconcile.
 */
export const MENTORSHIP_ASSIGN_PERMISSION = 'mentorship:assign';

/** An unrelated permission for the DEC-UM-002 capability-denial probe (Ida). */
export const UNRELATED_PERMISSION = 'form-campaigns:create';

const PAIRS_TABLE_CANDIDATES = [
  'mentorship_pairs',
  'MentorshipPair',
  'mentorship_pair',
  'MentorshipPairs',
] as const;
const AVAILABILITY_TABLE_CANDIDATES = [
  'mentorship_availability',
  'MentorshipAvailability',
  'mentorship_availabilities',
] as const;
const CAREER_EVENT_TABLE_CANDIDATES = [
  'user_events',
  'UserEvents',
  'career_events',
  'CareerEvents',
] as const;

async function firstExistingRelation(
  prisma: PrismaService,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      candidate,
    );
    if (rows[0]?.exists === true) {
      return candidate;
    }
  }
  return null;
}

/** Name of the `MentorshipPair` table if it exists, else `null` (G-CTX marker). */
export const mentorshipPairsTable = (
  prisma: PrismaService,
): Promise<string | null> =>
  firstExistingRelation(prisma, PAIRS_TABLE_CANDIDATES);

/** Name of the `MentorshipAvailability` table if it exists, else `null`. */
export const mentorshipAvailabilityTable = (
  prisma: PrismaService,
): Promise<string | null> =>
  firstExistingRelation(prisma, AVAILABILITY_TABLE_CANDIDATES);

// ---------------------------------------------------------------------------
// Boundary shapes (mentorship.md §2.1 / §5.4). Assertions target these.
// ---------------------------------------------------------------------------

export interface PairShape {
  id?: string;
  mentorUserId?: string;
  menteeUserId?: string;
  status?: 'active' | 'ended' | string;
  startedAt?: string | null;
  endedAt?: string | null;
  closureNote?: string;
  systemClosed?: boolean;
}

export interface S13SummaryShape {
  openToMentoring?: boolean;
  status?: string | null;
  mentor?: { userId?: string } | null;
  mentees?: Array<{ userId?: string }>;
  pairs?: PairShape[];
}

const asRecord = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

/**
 * The S13 inline mentorship summary on `GET /users/:id` (mentorship.md §5.4).
 * The assembler key is an open ambiguity — try the plausible names. `null`
 * today (no such key on the S1 card) is the committed red.
 */
export function s13Summary(body: unknown): S13SummaryShape | null {
  const record = asRecord(body);
  const candidate =
    record.s13 ??
    record.mentorship ??
    record.mentorshipSummary ??
    record.s13Summary ??
    record.s13Mentorship ??
    null;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

/**
 * Derived mentorship status (mentorship.md §2.3). The exact string form is an
 * ambiguity (`mentor` / `open to mentoring` in §2.3 vs `open_to_mentoring` in
 * the §5.4 query export vs `open-to-mentoring` in the directory filter) — the
 * predicates below accept every form.
 */
export function mentorshipStatusValue(body: unknown): string | null {
  const summary = s13Summary(body);
  const raw = summary?.status ?? asRecord(body).mentorshipStatus ?? null;
  return typeof raw === 'string' ? raw : null;
}

export const isMentorStatus = (value: string | null): boolean =>
  value === 'mentor';

export const isOpenToMentoringStatus = (value: string | null): boolean =>
  ['open to mentoring', 'open_to_mentoring', 'open-to-mentoring'].includes(
    value ?? '',
  );

export const pairsOf = (body: unknown): PairShape[] => {
  const record = asRecord(body);
  if (Array.isArray(record.items)) return record.items as PairShape[];
  if (Array.isArray(body)) return body as PairShape[];
  if (Array.isArray(record.pairs)) return record.pairs as PairShape[];
  return [];
};

// ---------------------------------------------------------------------------
// HTTP surface. Routes per mentorship.md §3 (the provisional scenario-draft
// routes `POST .../closure`, `GET /willing-mentors`, `PUT .../availability`
// are superseded). `mentorUserId`/`menteeUserId` + `closureNote` are the
// fixed body keys (§3); the scenario drafts' `mentorId`/`menteeId`/`note` are
// superseded.
// ---------------------------------------------------------------------------

export function mentorshipApi(testApp: TestApp) {
  const server = testApp.app.getHttpServer();
  return {
    listPairs: (viewerId: string, qs = '') =>
      request(server)
        .get(`/mentorship-pairs${qs}`)
        .set('authorization', bearer(viewerId)),
    getPair: (pairId: string | undefined, viewerId: string) =>
      request(server)
        .get(`/mentorship-pairs/${pairId}`)
        .set('authorization', bearer(viewerId)),
    createPair: (
      viewerId: string,
      mentorUserId: string,
      menteeUserId: string,
    ) =>
      request(server)
        .post('/mentorship-pairs')
        .set('authorization', bearer(viewerId))
        .send({ mentorUserId, menteeUserId }),
    endPair: (
      pairId: string | undefined,
      viewerId: string,
      body: Record<string, unknown>,
    ) =>
      request(server)
        .post(`/mentorship-pairs/${pairId}/end`)
        .set('authorization', bearer(viewerId))
        .send(body),
    pool: (viewerId: string) =>
      request(server)
        .get('/mentorship-pool')
        .set('authorization', bearer(viewerId)),
    getAvailability: (userId: string, viewerId: string) =>
      request(server)
        .get(`/users/${userId}/mentorship-availability`)
        .set('authorization', bearer(viewerId)),
    patchAvailability: (
      userId: string,
      viewerId: string,
      body: Record<string, unknown>,
    ) =>
      request(server)
        .patch(`/users/${userId}/mentorship-availability`)
        .set('authorization', bearer(viewerId))
        .send(body),
    getProfile: (userId: string, viewerId: string) =>
      request(server)
        .get(`/users/${userId}`)
        .set('authorization', bearer(viewerId)),
    getEvents: (userId: string, viewerId: string) =>
      request(server)
        .get(`/users/${userId}/events`)
        .set('authorization', bearer(viewerId)),
    listUsers: (viewerId: string, qs = '') =>
      request(server).get(`/users${qs}`).set('authorization', bearer(viewerId)),
  };
}

// ---------------------------------------------------------------------------
// Fixture run — wraps `RunFixtures` and adds a mentorship-scoped, wrapped
// teardown plus a project-line edge helper.
// ---------------------------------------------------------------------------

export class MentorshipFixtures {
  readonly rf: RunFixtures;
  readonly projectIds = new Set<string>();
  /** FR-policy / permission rows THIS wrapper created (torn down before users). */
  readonly grantPolicyIds = new Set<string>();
  readonly grantPermissionIds = new Set<string>();
  private grantSeq = 0;

  constructor(private readonly prisma: PrismaService) {
    this.rf = new RunFixtures(prisma);
  }

  get runId(): string {
    return this.rf.runId;
  }

  user(persona: string, overrides: Parameters<RunFixtures['user']>[1] = {}) {
    return this.rf.user(persona, overrides);
  }

  reportsTo(subordinateId: string, managerId: string): Promise<void> {
    return this.rf.reportsTo(subordinateId, managerId);
  }

  peoplePartnerOf(employeeId: string, ppId: string): Promise<void> {
    return this.rf.peoplePartnerOf(employeeId, ppId);
  }

  /**
   * A real FR-grant chain: active User -> UserPolicy -> FR Policy -> FR
   * PolicyPermission -> Permission(key). Mirrors `RunFixtures.grantFunctionalRole`
   * (and the ACM-1 shape) but with a per-grant-unique `targetRole` — two users
   * seeded in the same millisecond share a uuidv7 timestamp prefix, so the
   * adoption helper's `${runId}-${userId.slice(0,8)}` collides on
   * `Policies_targetRole_fr_key`. A non-existent `key` (e.g. the unseeded
   * `mentorship:assign`) is created here; a pre-existing canonical row is reused
   * and never torn down.
   */
  async grantFunctionalRole(userId: string, keys: readonly string[]) {
    const permissionIds: string[] = [];
    for (const key of keys) {
      const existing = await this.prisma.permission.findUnique({
        where: { key },
      });
      if (existing) {
        permissionIds.push(existing.id);
        continue;
      }
      const created = await this.prisma.permission.create({
        data: { key, description: `${key} (mentorship fixture)` },
      });
      this.grantPermissionIds.add(created.id);
      permissionIds.push(created.id);
    }

    const policy = await this.prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `${this.runId}-fr-${this.grantSeq++}-${userId.slice(-8)}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    this.grantPolicyIds.add(policy.id);

    await this.prisma.policyPermission.createMany({
      data: permissionIds.map((permissionId) => ({
        policyId: policy.id,
        permissionId,
        policyType: 'FR',
      })),
    });
    await this.prisma.userPolicy.create({
      data: { userId, policyId: policy.id },
    });

    return { policyId: policy.id, permissionIds };
  }

  /** Grant the (unseeded) `mentorship:assign` key via a real FR-policy chain. */
  grantMentorshipAssign(userId: string) {
    return this.grantFunctionalRole(userId, [MENTORSHIP_ASSIGN_PERMISSION]);
  }

  /**
   * A real project-line edge: `pmId` and `memberId` both sit on one `Project`
   * via `type='project'` `Relationship` rows.
   *
   * CAVEAT: the Access-Control graph adapter resolves `reporting` and `pp`
   * ONLY (`Audience = 'self'|'reporting'|'pp'|'colleague'` — no `'project'`;
   * `prisma-relationship-graph.adapter.ts` never reads `Relationship.type =
   * 'project'` or the `projects` table). So project-line closure-note
   * visibility (men-end-03 Pete, men-view-04) has a SECOND blocker beyond
   * G-CTX: project-line audience resolution is itself unbuilt. The edge is
   * seeded so the assertion is real the day both land.
   */
  async onProjectTogether(pmId: string, memberId: string): Promise<string> {
    const project = await this.prisma.project.create({
      data: { name: `${this.runId}-project` },
    });
    this.projectIds.add(project.id);
    await this.prisma.relationship.create({
      data: { userId: pmId, type: 'project', projectId: project.id },
    });
    await this.prisma.relationship.create({
      data: { userId: memberId, type: 'project', projectId: project.id },
    });
    return project.id;
  }

  /** Wrapped, scoped teardown (DEC-UM-010). */
  async cleanup(): Promise<void> {
    const userIds = [...this.rf.userIds];

    const rawDeleteByUsers = async (
      table: string | null,
      columns: string[],
    ): Promise<void> => {
      if (!table) return;
      const where = columns.map((c) => `"${c}" = ANY($1::uuid[])`).join(' OR ');
      // Column names assume Prisma-default camelCase columns (schema.prisma
      // house style — `reportsToUserId` etc. are unquoted-camelCase in the DB).
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE ${where}`,
        userIds,
      );
    };

    const steps: Array<() => Promise<unknown>> = [
      async () =>
        rawDeleteByUsers(await mentorshipPairsTable(this.prisma), [
          'mentorUserId',
          'menteeUserId',
        ]),
      async () =>
        rawDeleteByUsers(await mentorshipAvailabilityTable(this.prisma), [
          'userId',
        ]),
      async () =>
        rawDeleteByUsers(
          await firstExistingRelation(
            this.prisma,
            CAREER_EVENT_TABLE_CANDIDATES,
          ),
          ['userId'],
        ),
      // FR-grant chains this wrapper created — before `rf.cleanup` deletes the
      // users they attach to (UserPolicy.userId is onDelete: Restrict).
      async () =>
        this.prisma.userPolicy.deleteMany({
          where: { policyId: { in: [...this.grantPolicyIds] } },
        }),
      async () =>
        this.prisma.policyPermission.deleteMany({
          where: { policyId: { in: [...this.grantPolicyIds] } },
        }),
      async () =>
        this.prisma.policy.deleteMany({
          where: { id: { in: [...this.grantPolicyIds] } },
        }),
      async () =>
        this.prisma.permission.deleteMany({
          where: { id: { in: [...this.grantPermissionIds] } },
        }),
      // relationships -> (rf's own) policies/permissions -> users (+ namespace sweep)
      async () => this.rf.cleanup(),
      // projects last — their `Relationship` rows are gone by now (onDelete:
      // Restrict would otherwise block the delete).
      async () =>
        this.prisma.project.deleteMany({
          where: { id: { in: [...this.projectIds] } },
        }),
    ];

    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn(`[${this.runId}] mentorship teardown step failed`, error);
      }
    }
  }
}

export type { User };
