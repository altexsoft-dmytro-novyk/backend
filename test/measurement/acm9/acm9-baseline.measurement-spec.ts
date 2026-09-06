import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import {
  arch,
  availableParallelism,
  cpus,
  freemem,
  platform,
  release,
  totalmem,
} from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../../src/access-control/application/access-control.facade';
import { AppModule } from '../../../src/app.module';
import { envValidationSchema } from '../../../src/config/env.validation';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  finalizeArtifact,
  isCompatibleBaseline,
  manifestHash,
  nearestRank,
  readArtifact,
  reserveArtifact,
  resolveStatus,
  type ReservedArtifact,
} from './manifest';

const TARGET_COUNT = 500;
const WARM_UPS = 5;
const SAMPLES = 20;
const LIMIT_MS = 2_000;
const DEPTHS = [5, 25, 50, 100, 200, 300, 400, 499] as const;
const ARTIFACT_DIRECTORY = resolve(
  __dirname,
  '../../../../../_bmad-output/test-artifacts/performance',
);
type Gate = 'reporting' | 'direct_pp' | 'colleague' | 'mixed';
type Measurement = { value_ms: number; error: null };
type GateResult = {
  gate: Gate;
  shape: string;
  depth: number;
  target_count: number;
  warm_up_count: number;
  sample_count: number;
  samples: Measurement[];
  p50_ms: number;
  p95_ms: number;
  worst_ms: number;
  query_count: number;
  plan_reference: string;
};

const errorDetail = (error: unknown) => ({
  error_class: error instanceof Error ? error.constructor.name : typeof error,
  error_message: error instanceof Error ? error.message : String(error),
});
const isTimeout = (error: unknown) =>
  /57014|statement timeout|canceling statement/i.test(
    error instanceof Error ? error.message : String(error),
  );
const revision = (path: string): string =>
  execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
const round = (value: number): number => Number(value.toFixed(3));

describe('ACM9 PostgreSQL baseline (explicit opt-in)', () => {
  const role = process.env.ACM9_ROLE === 'final' ? 'final' : 'baseline';
  const runId = `acm9-${Date.now()}-${uuidv7().slice(-12)}`;
  let artifact: ReservedArtifact;
  let moduleRef: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let facade: AccessControlFacade | undefined;
  let ids: string[] = [];
  let viewer = '';
  let anchor = '';
  const plans: Array<{ id: string; source: string; plan: unknown }> = [];
  const completed: GateResult[] = [];
  let firstBreach: Record<string, unknown> | null = null;
  let fixtureHash = '';
  let environmentHash = '';
  let comparable = true;

  const publishIncomplete = async (error: unknown, stopReason: string) => {
    const current = await readArtifact(artifact.path);
    if (current.status === 'FAIL') return;
    await finalizeArtifact(artifact, {
      status: 'INCOMPLETE',
      stop_reason: stopReason,
      ...errorDetail(error),
      completed_gates: completed,
      first_breach: firstBreach,
      plans,
    });
  };

  const clean = async () => {
    if (!prisma || ids.length === 0) return;
    await prisma.relationship.deleteMany({
      where: {
        OR: [
          { userId: { in: [...ids, viewer, anchor] } },
          { reportsToUserId: { in: [...ids, viewer, anchor] } },
        ],
      },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [...ids, viewer, anchor] } },
    });
  };

  const seed = async () => {
    if (!prisma) throw new Error('Prisma unavailable');
    ids = Array.from({ length: TARGET_COUNT }, () => uuidv7());
    viewer = uuidv7();
    anchor = uuidv7();
    const all = [anchor, viewer, ...ids];
    await prisma.user.create({
      data: {
        id: anchor,
        firstName: 'ACM9',
        lastName: 'Anchor',
        position: 'Anchor',
        country: 'PL',
        city: 'Krakow',
        workEmail: `${runId}-anchor@example.invalid`,
        companyJoinDate: new Date('2020-01-01'),
        createdBy: anchor,
      },
    });
    await prisma.user.create({
      data: {
        id: viewer,
        firstName: 'ACM9',
        lastName: 'Viewer',
        position: 'Viewer',
        country: 'PL',
        city: 'Krakow',
        workEmail: `${runId}-viewer@example.invalid`,
        companyJoinDate: new Date('2020-01-01'),
        createdBy: anchor,
      },
    });
    await prisma.user.createMany({
      data: ids.map((id, index) => ({
        id,
        firstName: 'ACM9',
        lastName: `Target${index + 1}`,
        position: 'Target',
        country: 'PL',
        city: 'Krakow',
        workEmail: `${runId}-${index + 1}@example.invalid`,
        companyJoinDate: new Date('2020-01-01'),
        createdBy: anchor,
      })),
    });
    if (ids.length !== TARGET_COUNT || all.length !== TARGET_COUNT + 2)
      throw new Error(
        'Fixture must contain 500 active targets, one viewer, and one isolation anchor',
      );
  };

  const configure = async (gate: Gate, depth: number) => {
    if (!prisma) throw new Error('Prisma unavailable');
    await prisma.relationship.deleteMany({ where: { userId: { in: ids } } });
    const relations: Array<{
      userId: string;
      type: 'direct' | 'people_partner';
      reportsToUserId: string;
    }> = [];
    for (let index = 0; index < ids.length; index += 1) {
      const reporting =
        gate === 'reporting' || (gate === 'mixed' && index < 250);
      const parent =
        depth === 5
          ? index < 4
            ? reporting
              ? viewer
              : anchor
            : ids[Math.floor((index - 1) / 4)]
          : index < depth
            ? index === 0
              ? reporting
                ? viewer
                : anchor
              : ids[index - 1]
            : reporting
              ? viewer
              : anchor;
      relations.push({
        userId: ids[index],
        type: 'direct',
        reportsToUserId: parent,
      });
      const pp =
        gate === 'direct_pp' ||
        (gate === 'mixed' && index >= 125 && index < 375);
      if (pp)
        relations.push({
          userId: ids[index],
          type: 'people_partner',
          reportsToUserId: viewer,
        });
    }
    await prisma.relationship.createMany({ data: relations });
    await prisma.$executeRawUnsafe('ANALYZE "relationships"');
  };

  const capturePlan = async (gate: Gate, depth: number): Promise<string> => {
    if (!prisma) throw new Error('Prisma unavailable');
    const id = `${gate}-${depth}`;
    const plan = await prisma.$queryRawUnsafe(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT r."userId" FROM "relationships" r WHERE r."type" = \'direct\'::"RelationshipType" LIMIT 1',
    );
    plans.push({
      id,
      source:
        'representative direct relationship hot-path predicate; captured outside timed facade samples',
      plan,
    });
    return id;
  };

  const call = async (): Promise<Measurement> => {
    if (!facade) throw new Error('AccessControlFacade unavailable');
    const start = performance.now();
    await facade.resolveAudiences(viewer, ids);
    return { value_ms: performance.now() - start, error: null };
  };

  const measure = async (gate: Gate, depth: number) => {
    await configure(gate, depth);
    const planReference = await capturePlan(gate, depth);
    try {
      for (let warm = 0; warm < WARM_UPS; warm += 1) await call();
      const samples: Measurement[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1)
        samples.push(await call());
      const values = samples.map((sample) => sample.value_ms);
      const result: GateResult = {
        gate,
        shape: depth === 5 ? 'balanced-depth-5' : 'acyclic-chain',
        depth,
        target_count: TARGET_COUNT,
        warm_up_count: WARM_UPS,
        sample_count: SAMPLES,
        samples,
        p50_ms: round(nearestRank(values, 0.5)),
        p95_ms: round(nearestRank(values, 0.95)),
        worst_ms: round(Math.max(...values)),
        query_count: (WARM_UPS + SAMPLES) * 3,
        plan_reference: planReference,
      };
      completed.push(result);
      if (result.p95_ms > LIMIT_MS || result.worst_ms > LIMIT_MS)
        firstBreach = {
          gate,
          shape: result.shape,
          depth,
          reason: result.p95_ms > LIMIT_MS ? 'p95_ms' : 'worst_ms',
          p95_ms: result.p95_ms,
          worst_ms: result.worst_ms,
        };
    } catch (error) {
      if (isTimeout(error))
        firstBreach = {
          gate,
          shape: depth === 5 ? 'balanced-depth-5' : 'acyclic-chain',
          depth,
          reason: 'statement_timeout',
          ...errorDetail(error),
        };
      else throw error;
    }
  };

  it('runs only the requested baseline protocol and preserves an auditable result', async () => {
    artifact = await reserveArtifact(ARTIFACT_DIRECTORY, role, runId);
    try {
      const backendRoot = resolve(__dirname, '../../..');
      const workspaceRoot = resolve(backendRoot, '../..');
      const fixtureManifest = {
        manifest_version: 'ACM9-MANIFEST-v1',
        target_count: TARGET_COUNT,
        active_targets: TARGET_COUNT,
        gates: ['reporting', 'direct_pp', 'colleague', 'mixed'],
        balanced_depth: 5,
        acyclic_depths: [25, 50, 100, 200, 300, 400, 499],
        warm_ups: WARM_UPS,
        samples: SAMPLES,
        nullable_baseline_run_id: null,
      };
      fixtureHash = manifestHash(fixtureManifest);
      // memory_free_bytes is a point-in-time system reading, not a machine/
      // runtime CONFIGURATION property — unlike every other field here, it
      // changes from one moment to the next on the same otherwise-identical
      // machine and can never be expected to match a prior run. It is kept in
      // the recorded manifest for diagnostics but deliberately excluded from
      // the hashed subset: the hash's job is to prove the CONFIGURATION was
      // unchanged, not that no bytes moved.
      const environmentManifest = {
        manifest_version: 'ACM9-MANIFEST-v1',
        postgres_configuration: null,
        node_version: process.version,
        platform: `${platform()} ${release()} ${arch()}`,
        cpu_count: cpus().length,
        available_parallelism: availableParallelism(),
        memory_total_bytes: totalmem(),
        memory_free_bytes: freemem(),
        topology: 'local PostgreSQL via DATABASE_URL',
        isolation_load_policy:
          'single Jest worker; dedicated UUID fixture rows; no concurrent harness load',
        nullable_container_limits: null,
      };
      const hashedEnvironmentManifest = Object.fromEntries(
        Object.entries(environmentManifest).filter(
          ([key]) => key !== 'memory_free_bytes',
        ),
      );
      environmentHash = manifestHash(hashedEnvironmentManifest);
      await finalizeArtifact(artifact, {
        fixture_manifest: fixtureManifest,
        fixture_manifest_hash: fixtureHash,
        environment_manifest: environmentManifest,
        environment_manifest_hash: environmentHash,
        source_revision: revision(backendRoot),
        workspace_revision: revision(workspaceRoot),
        runtime: { node: process.version, postgres: null },
        topology: environmentManifest.topology,
        isolation_load_policy: environmentManifest.isolation_load_policy,
        warm_up_count: WARM_UPS,
        sample_count: SAMPLES,
        target_count: TARGET_COUNT,
      });
      moduleRef = await Test.createTestingModule({
        imports:
          role === 'final'
            ? [AppModule]
            : [
                ConfigModule.forRoot({
                  isGlobal: true,
                  validationSchema: envValidationSchema,
                }),
                PrismaModule,
                AccessControlModule,
              ],
      }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      facade = moduleRef.get(AccessControlFacade);
      const prismaService = prisma;
      if (!prismaService) throw new Error('Prisma service was not resolved');
      const postgres = await prismaService.$queryRaw<
        Array<{ version: string; server_version: string }>
      >`SELECT version(), current_setting('server_version') AS server_version`;
      const postgresConfiguration = await prismaService.$queryRawUnsafe(
        "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'statement_timeout') ORDER BY name",
      );
      const migrations = await prismaService.$queryRawUnsafe(
        'SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at',
      );
      await finalizeArtifact(artifact, {
        runtime: { node: process.version, postgres: postgres[0] },
        applied_migration_revision: migrations,
        postgres_configuration: postgresConfiguration,
      });
      if (role === 'final') {
        const baselinePath = process.env.ACM9_BASELINE_ARTIFACT;
        if (!baselinePath)
          throw new Error('ACM9 final requires ACM9_BASELINE_ARTIFACT');
        const baseline = await readArtifact(baselinePath);
        // PRECONDITION (hard refuse before measurement): the baseline must exist,
        // be PASS, and share this run's protocol version. A PASS baseline under a
        // different protocol version is not comparable and cannot satisfy the gate.
        if (
          baseline.status !== 'PASS' ||
          baseline.protocol_version !== 'ACM9-MVP-v1'
        )
          throw new Error(
            'ACM9 final requires a PASS baseline under protocol version ACM9-MVP-v1',
          );
        // Fixture/environment hash agreement is NOT a precondition: per the
        // PRECEDENCE rule, a mismatch here must not block measurement. It only
        // downgrades comparability, so an absolute breach still finalizes FAIL
        // and an unbreached mismatched run finalizes INCOMPLETE, never PASS.
        comparable = isCompatibleBaseline(baseline, {
          protocolVersion: 'ACM9-MVP-v1',
          fixtureHash,
          environmentHash,
        });
        await finalizeArtifact(artifact, {
          baseline_artifact_path: baselinePath,
          baseline_run_id: baseline.run_id,
          comparability: comparable ? 'comparable' : 'mismatched',
        });
      }
      await seed();
      for (const gate of [
        'reporting',
        'direct_pp',
        'colleague',
        'mixed',
      ] as const) {
        for (const depth of DEPTHS) {
          await measure(gate, depth);
          if (firstBreach !== null) break;
        }
        if (firstBreach !== null) break;
      }
      const status = resolveStatus({ breach: firstBreach, comparable });
      await finalizeArtifact(artifact, {
        status,
        stop_reason: firstBreach === null ? 'completed' : 'absolute_breach',
        completed_gates: completed,
        first_breach: firstBreach,
        plans,
        query_count: completed.reduce(
          (total, result) => total + result.query_count,
          0,
        ),
        fixture_manifest_hash: fixtureHash,
        environment_manifest_hash: environmentHash,
        comparability: comparable ? 'comparable' : 'mismatched',
      });
      expect(firstBreach).toBeNull();
    } catch (error) {
      await publishIncomplete(
        error,
        firstBreach === null ? 'infrastructure_error' : 'absolute_breach',
      );
      throw error;
    } finally {
      try {
        await clean();
      } finally {
        if (moduleRef) await moduleRef.close();
      }
    }
  });
});
