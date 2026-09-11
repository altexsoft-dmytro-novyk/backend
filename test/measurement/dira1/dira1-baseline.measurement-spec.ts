import { INestApplication } from '@nestjs/common';
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
import request from 'supertest';
import { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  bearer,
  bootstrapTestApp,
  RunFixtures,
} from '../../user-management/access-control-adoption/fixtures';
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
const BRANCHING_FACTOR = 4;
const ARTIFACT_DIRECTORY = resolve(
  __dirname,
  '../../../../../_bmad-output/test-artifacts/performance',
);

type ListGate = {
  name: string;
  path: string;
  page_size: number;
  includes_total_count: true;
  filter_summary: string;
};

const LIST_GATES: ListGate[] = [
  {
    name: 'default-first-page',
    path: '/users?page=1&pageSize=25',
    page_size: 25,
    includes_total_count: true,
    filter_summary: 'active only (default), first page',
  },
  {
    name: 'filtered-first-page',
    path: '/users?country=Poland&position=Engineer&page=1&pageSize=25',
    page_size: 25,
    includes_total_count: true,
    filter_summary: 'country=Poland, position=Engineer',
  },
  {
    name: 'filtered-deep-page',
    path: '/users?country=Poland&page=3&pageSize=50',
    page_size: 50,
    includes_total_count: true,
    filter_summary: 'country=Poland, page 3',
  },
];

type Measurement = { value_ms: number; error: null };
type GateResult = {
  gate: string;
  path: string;
  page_size: number;
  includes_total_count: true;
  filter_summary: string;
  population_count: number;
  warm_up_count: number;
  sample_count: number;
  samples: Measurement[];
  p50_ms: number;
  p95_ms: number;
  worst_ms: number;
  plan_reference: string;
};

const errorDetail = (error: unknown) => ({
  error_class: error instanceof Error ? error.constructor.name : typeof error,
  error_message: error instanceof Error ? error.message : String(error),
});
const revision = (path: string): string =>
  execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
const round = (value: number): number => Number(value.toFixed(3));

describe('DIRA1 All Employees list HTTP measurement (explicit opt-in)', () => {
  const role = process.env.DIRA1_ROLE === 'final' ? 'final' : 'baseline';
  const runId = `dira1-${Date.now()}-${uuidv7().slice(-12)}`;
  let artifact: ReservedArtifact;
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService | undefined;
  let viewerId = '';
  let targetIds: string[] = [];
  let fx: RunFixtures | undefined;
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
    if (fx) await fx.cleanup();
    if (!prisma || targetIds.length === 0) return;
    await prisma.relationship.deleteMany({
      where: {
        OR: [
          { userId: { in: targetIds } },
          { reportsToUserId: { in: [viewerId, ...targetIds] } },
        ],
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: targetIds } } });
  };

  const seed = async () => {
    if (!prisma) throw new Error('Prisma unavailable');
    fx = new RunFixtures(prisma);
    const root = await fx.user('dira1-root', {
      position: 'HR Admin',
      country: 'Poland',
    });
    await fx.grantFunctionalRole(root.id, ['user-management:list']);
    viewerId = root.id;
    targetIds = Array.from({ length: TARGET_COUNT }, () => uuidv7());
    await prisma.user.createMany({
      data: targetIds.map((id, index) => ({
        id,
        firstName: 'DIRA1',
        lastName: `Employee${index + 1}`,
        position: 'Engineer',
        country: 'Poland',
        city: 'Krakow',
        workEmail: `${fx!.runId}-${index + 1}@company.example`,
        companyJoinDate: new Date('2020-01-01'),
        createdBy: viewerId,
      })),
    });
    for (const id of targetIds) fx.userIds.add(id);
    const relations = targetIds.map((userId, index) => ({
      userId,
      type: 'direct' as const,
      reportsToUserId:
        index < BRANCHING_FACTOR
          ? viewerId
          : targetIds[Math.floor((index - 1) / BRANCHING_FACTOR)],
    }));
    await prisma.relationship.createMany({ data: relations });
    await prisma.$executeRawUnsafe('ANALYZE "users"');
    await prisma.$executeRawUnsafe('ANALYZE "relationships"');
    if (targetIds.length !== TARGET_COUNT)
      throw new Error(`Fixture must contain ${TARGET_COUNT} active employees`);
  };

  const capturePlan = async (gate: ListGate): Promise<string> => {
    if (!prisma) throw new Error('Prisma unavailable');
    const id = gate.name;
    const plan = await prisma.$queryRaw`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT COUNT(*)::bigint AS total
      FROM "users"
      WHERE "isActive" = true AND "country" = 'Poland'
    `;
    plans.push({
      id,
      source:
        'representative list count predicate for country=Poland; captured outside timed HTTP samples',
      plan,
    });
    return id;
  };

  const call = async (gate: ListGate): Promise<Measurement> => {
    if (!app) throw new Error('HTTP app unavailable');
    const start = performance.now();
    const response = await request(app.getHttpServer())
      .get(gate.path)
      .set('Authorization', bearer(viewerId));
    if (response.status !== 200) {
      throw new Error(
        `GET ${gate.path} returned ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }
    return { value_ms: performance.now() - start, error: null };
  };

  const measure = async (gate: ListGate) => {
    const planReference = await capturePlan(gate);
    for (let warm = 0; warm < WARM_UPS; warm += 1) await call(gate);
    const samples: Measurement[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1)
      samples.push(await call(gate));
    const values = samples.map((sample) => sample.value_ms);
    const result: GateResult = {
      gate: gate.name,
      path: gate.path,
      page_size: gate.page_size,
      includes_total_count: true,
      filter_summary: gate.filter_summary,
      population_count: TARGET_COUNT,
      warm_up_count: WARM_UPS,
      sample_count: SAMPLES,
      samples,
      p50_ms: round(nearestRank(values, 0.5)),
      p95_ms: round(nearestRank(values, 0.95)),
      worst_ms: round(Math.max(...values)),
      plan_reference: planReference,
    };
    completed.push(result);
    if (result.p95_ms > LIMIT_MS || result.worst_ms > LIMIT_MS)
      firstBreach = {
        gate: gate.name,
        path: gate.path,
        reason: result.p95_ms > LIMIT_MS ? 'p95_ms' : 'worst_ms',
        p95_ms: result.p95_ms,
        worst_ms: result.worst_ms,
      };
  };

  it('runs only the requested DIRA1 protocol and preserves an auditable result', async () => {
    artifact = await reserveArtifact(ARTIFACT_DIRECTORY, role, runId);
    try {
      const backendRoot = resolve(__dirname, '../../..');
      const workspaceRoot = resolve(backendRoot, '../..');
      const fixtureManifest = {
        manifest_version: 'DIRA1-MANIFEST-v1',
        subject: 'GET /users All Employees list HTTP route',
        population_count: TARGET_COUNT,
        relationship_shape: 'balanced-depth-4 reporting tree',
        gates: LIST_GATES.map((gate) => gate.name),
        warm_ups: WARM_UPS,
        samples: SAMPLES,
        nullable_baseline_run_id: null,
      };
      fixtureHash = manifestHash(fixtureManifest);
      const environmentManifest = {
        manifest_version: 'DIRA1-MANIFEST-v1',
        postgres_configuration: null,
        node_version: process.version,
        platform: `${platform()} ${release()} ${arch()}`,
        cpu_count: cpus().length,
        available_parallelism: availableParallelism(),
        memory_total_bytes: totalmem(),
        memory_free_bytes: freemem(),
        topology: 'local PostgreSQL via DATABASE_URL',
        isolation_load_policy:
          'single Jest worker; one HTTP client; sequential requests; dedicated UUID fixture rows',
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
        population_count: TARGET_COUNT,
      });
      const booted = await bootstrapTestApp();
      app = booted.app;
      prisma = booted.prisma;
      const postgres = await prisma.$queryRaw<
        Array<{ version: string; server_version: string }>
      >`SELECT version(), current_setting('server_version') AS server_version`;
      const postgresConfiguration = await prisma.$queryRawUnsafe(
        "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'statement_timeout') ORDER BY name",
      );
      const migrations = await prisma.$queryRawUnsafe(
        'SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at',
      );
      await finalizeArtifact(artifact, {
        runtime: { node: process.version, postgres: postgres[0] },
        applied_migration_revision: migrations,
        postgres_configuration: postgresConfiguration,
      });
      if (role === 'final') {
        const baselinePath = process.env.DIRA1_BASELINE_ARTIFACT;
        if (!baselinePath)
          throw new Error('DIRA1 final requires DIRA1_BASELINE_ARTIFACT');
        const baseline = await readArtifact(baselinePath);
        if (
          baseline.status !== 'PASS' ||
          baseline.protocol_version !== 'DIRA1-MVP-v1'
        )
          throw new Error(
            'DIRA1 final requires a PASS baseline under protocol version DIRA1-MVP-v1',
          );
        comparable = isCompatibleBaseline(baseline, {
          protocolVersion: 'DIRA1-MVP-v1',
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
      for (const gate of LIST_GATES) {
        await measure(gate);
        if (firstBreach !== null) break;
      }
      const status = resolveStatus({ breach: firstBreach, comparable });
      await finalizeArtifact(artifact, {
        status,
        stop_reason: firstBreach === null ? 'completed' : 'absolute_breach',
        completed_gates: completed,
        first_breach: firstBreach,
        plans,
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
        if (app) await app.close();
      }
    }
  });
});
