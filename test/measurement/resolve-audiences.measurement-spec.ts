import { ConfigModule } from '@nestjs/config';
import { TestingModule, Test } from '@nestjs/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  availableParallelism,
  arch,
  cpus,
  freemem,
  platform,
  release,
  totalmem,
} from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import {
  RELATIONSHIP_GRAPH_PORT,
  type RelationshipGraphPort,
} from '../../src/access-control/domain/interfaces/relationship-graph.port';
import { envValidationSchema } from '../../src/config/env.validation';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const FIXTURE_SIZE = 500;
const BRANCHING_FACTOR = 4;
const WARM_UP_COUNT = 5;
const SAMPLE_COUNT = 20;
const REQUEST_BUDGET_MS = 2_000;
const CHAIN_DEPTHS = [25, 50, 100, 200, 300, 400, 499] as const;
const REPORT_DIRECTORY = resolve(
  __dirname,
  '../../../../_bmad-output/test-artifacts/performance',
);
const JSON_REPORT_PATH = resolve(
  REPORT_DIRECTORY,
  'p6-resolve-audiences-postgresql.json',
);
const MARKDOWN_REPORT_PATH = resolve(
  REPORT_DIRECTORY,
  'p6-resolve-audiences-postgresql.md',
);

type Timing = {
  totalMs: number;
  transactionMs: number | null;
  facadeOverheadMs: number | null;
  outcome: 'success' | 'statement_timeout' | 'outer_timeout' | 'error';
  error: string | null;
};

type Statistics = {
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
};

type ScenarioResult = {
  name: string;
  shape: 'balanced' | 'acyclic_chain';
  fixtureSize: number;
  hierarchyDepth: number;
  viewerIndex: number;
  targetCount: number;
  targetDepths: number[];
  cold: Timing;
  warmUpCount: number;
  sampleCount: number;
  warm: {
    total: Statistics | null;
    transaction: Statistics | null;
    facadeOverhead: Statistics | null;
    outcomes: Record<Timing['outcome'], number>;
    samples: Timing[];
  };
  firstBudgetBreachMs: number | null;
};

type TimeoutProbeResult = {
  configuredStatementTimeoutMs: number;
  sleepMs: number;
  databaseOnly: Timing;
  competition: {
    requestBudgetMs: number;
    firstFailure: 'statement_timeout' | 'outer_timeout' | 'error';
    firstFailureElapsedMs: number;
    eventualDatabaseOutcome: Timing['outcome'];
    eventualDatabaseElapsedMs: number;
  };
};

const round = (value: number): number => Number(value.toFixed(3));

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const classifyError = (
  error: unknown,
): Exclude<Timing['outcome'], 'success' | 'outer_timeout'> => {
  const text = errorText(error);
  return /57014|statement timeout|canceling statement due to statement timeout/i.test(
    text,
  )
    ? 'statement_timeout'
    : 'error';
};

const stats = (values: number[]): Statistics | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    worstMs: round(sorted[sorted.length - 1]),
  };
};

const countOutcomes = (
  samples: Timing[],
): Record<Timing['outcome'], number> => ({
  success: samples.filter((sample) => sample.outcome === 'success').length,
  statement_timeout: samples.filter(
    (sample) => sample.outcome === 'statement_timeout',
  ).length,
  outer_timeout: samples.filter((sample) => sample.outcome === 'outer_timeout')
    .length,
  error: samples.filter((sample) => sample.outcome === 'error').length,
});

const depthFor = (index: number, branchingFactor: number): number => {
  let depth = 0;
  let cursor = index;
  while (cursor > 0) {
    cursor = Math.floor((cursor - 1) / branchingFactor);
    depth += 1;
  }
  return depth;
};

const formatStats = (value: Statistics | null): string =>
  value === null
    ? 'n/a'
    : `${value.p50Ms.toFixed(3)} / ${value.p95Ms.toFixed(3)} / ${value.worstMs.toFixed(3)}`;

const timingForJson = (timing: Timing): Timing => ({
  ...timing,
  totalMs: round(timing.totalMs),
  transactionMs:
    timing.transactionMs === null ? null : round(timing.transactionMs),
  facadeOverheadMs:
    timing.facadeOverheadMs === null ? null : round(timing.facadeOverheadMs),
});

describe('P6 PostgreSQL resolveAudiences measurement (opt-in)', () => {
  let moduleFixture: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let facade: AccessControlFacade;
  let graph: RelationshipGraphPort;
  let ids: string[] = [];
  let lastTransactionMs: number | null = null;
  const runId = `p6-${Date.now()}`;

  const cleanup = async (): Promise<void> => {
    if (prisma !== undefined && ids.length > 0) {
      await prisma.relationship.deleteMany({
        where: {
          OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
        },
      });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    ids = [];
  };

  const seedUsers = async (): Promise<void> => {
    if (prisma === undefined) {
      throw new Error('Prisma is not initialized');
    }
    ids = Array.from({ length: FIXTURE_SIZE }, () => uuidv7());
    await prisma.user.create({
      data: {
        id: ids[0],
        firstName: 'P6-000',
        lastName: 'Measurement',
        position: 'Executive',
        country: 'PL',
        city: 'Krakow',
        workEmail: `${runId}-000@company.example`,
        companyJoinDate: new Date('2020-01-01'),
        createdBy: ids[0],
      },
    });
    await prisma.user.createMany({
      data: ids.slice(1).map((id, index) => {
        const ordinal = index + 1;
        return {
          id,
          firstName: `P6-${ordinal.toString().padStart(3, '0')}`,
          lastName: 'Measurement',
          position: ordinal < 5 ? 'Director' : 'Engineer',
          country: 'PL',
          city: 'Krakow',
          workEmail: `${runId}-${ordinal.toString().padStart(3, '0')}@company.example`,
          companyJoinDate: new Date('2020-01-01'),
          createdBy: ids[0],
        };
      }),
    });
  };

  const applyBalancedRelationships = async (): Promise<void> => {
    if (prisma === undefined) {
      throw new Error('Prisma is not initialized');
    }
    await prisma.relationship.createMany({
      data: [
        ...ids.slice(1).map((id, index) => ({
          userId: id,
          type: 'direct' as const,
          reportsToUserId: ids[Math.floor((index + 1 - 1) / BRANCHING_FACTOR)],
        })),
        ...ids
          .slice(20)
          .filter((_, index) => index % 20 === 0)
          .map((id) => ({
            userId: id,
            type: 'people_partner' as const,
            reportsToUserId: ids[2],
          })),
      ],
    });
    await prisma.$executeRawUnsafe(`ANALYZE "relationships"`);
  };

  const applyChainRelationships = async (chainDepth: number): Promise<void> => {
    if (prisma === undefined) {
      throw new Error('Prisma is not initialized');
    }
    await prisma.relationship.deleteMany({
      where: { userId: { in: ids }, type: 'direct' },
    });
    await prisma.relationship.createMany({
      data: ids.slice(1).map((id, index) => {
        const ordinal = index + 1;
        return {
          userId: id,
          type: 'direct' as const,
          reportsToUserId: ordinal <= chainDepth ? ids[ordinal - 1] : ids[0],
        };
      }),
    });
    await prisma.$executeRawUnsafe(`ANALYZE "relationships"`);
  };

  const measureFacade = async (
    viewerId: string,
    targetIds: string[],
  ): Promise<Timing> => {
    lastTransactionMs = null;
    const started = performance.now();
    try {
      await facade.resolveAudiences(viewerId, targetIds);
      const totalMs = performance.now() - started;
      return timingForJson({
        totalMs,
        transactionMs: lastTransactionMs,
        facadeOverheadMs:
          lastTransactionMs === null
            ? null
            : Math.max(0, totalMs - lastTransactionMs),
        outcome: 'success',
        error: null,
      });
    } catch (error) {
      const totalMs = performance.now() - started;
      return timingForJson({
        totalMs,
        transactionMs: lastTransactionMs,
        facadeOverheadMs:
          lastTransactionMs === null
            ? null
            : Math.max(0, totalMs - lastTransactionMs),
        outcome: classifyError(error),
        error: errorText(error),
      });
    }
  };

  const runScenario = async ({
    name,
    shape,
    hierarchyDepth,
    viewerIndex,
    targetIndexes,
    targetDepths,
    expectAllReporting,
  }: {
    name: string;
    shape: ScenarioResult['shape'];
    hierarchyDepth: number;
    viewerIndex: number;
    targetIndexes: number[];
    targetDepths: number[];
    expectAllReporting: boolean;
  }): Promise<ScenarioResult> => {
    const targetIds = targetIndexes.map((index) => ids[index]);
    const cold = await measureFacade(ids[viewerIndex], targetIds);
    for (let index = 0; index < WARM_UP_COUNT; index += 1) {
      await measureFacade(ids[viewerIndex], targetIds);
    }
    const samples: Timing[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      samples.push(await measureFacade(ids[viewerIndex], targetIds));
    }
    const validation = await facade.resolveAudiences(
      ids[viewerIndex],
      targetIds,
    );
    expect(validation.size).toBe(new Set(targetIds).size);
    if (expectAllReporting) {
      for (const targetId of targetIds) {
        expect(
          validation
            .get(targetId)
            ?.has(targetId === ids[viewerIndex] ? 'self' : 'reporting'),
        ).toBe(true);
      }
    }
    const successful = samples.filter((sample) => sample.outcome === 'success');
    return {
      name,
      shape,
      fixtureSize: FIXTURE_SIZE,
      hierarchyDepth,
      viewerIndex,
      targetCount: targetIds.length,
      targetDepths,
      cold,
      warmUpCount: WARM_UP_COUNT,
      sampleCount: SAMPLE_COUNT,
      warm: {
        total: stats(successful.map((sample) => sample.totalMs)),
        transaction: stats(
          successful.flatMap((sample) =>
            sample.transactionMs === null ? [] : [sample.transactionMs],
          ),
        ),
        facadeOverhead: stats(
          successful.flatMap((sample) =>
            sample.facadeOverheadMs === null ? [] : [sample.facadeOverheadMs],
          ),
        ),
        outcomes: countOutcomes(samples),
        samples,
      },
      firstBudgetBreachMs:
        samples.find((sample) => sample.totalMs > REQUEST_BUDGET_MS)?.totalMs ??
        (cold.totalMs > REQUEST_BUDGET_MS ? cold.totalMs : null),
    };
  };

  const runDatabaseTimeout = async (): Promise<Timing> => {
    if (prisma === undefined) {
      throw new Error('Prisma is not initialized');
    }
    const started = performance.now();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '2s'`);
        await tx.$queryRawUnsafe(`SELECT pg_sleep(2.2)`);
      });
      return {
        totalMs: round(performance.now() - started),
        transactionMs: null,
        facadeOverheadMs: null,
        outcome: 'success',
        error: null,
      };
    } catch (error) {
      return {
        totalMs: round(performance.now() - started),
        transactionMs: null,
        facadeOverheadMs: null,
        outcome: classifyError(error),
        error: errorText(error),
      };
    }
  };

  const runTimeoutProbe = async (): Promise<TimeoutProbeResult> => {
    const databaseOnly = await runDatabaseTimeout();
    const started = performance.now();
    const databaseAttempt = runDatabaseTimeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outerTimeout = new Promise<'outer_timeout'>((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout('outer_timeout'),
        REQUEST_BUDGET_MS,
      );
    });
    const first = await Promise.race([
      databaseAttempt.then((result) => result.outcome),
      outerTimeout,
    ]);
    const firstFailureElapsedMs = round(performance.now() - started);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    const eventualDatabase = await databaseAttempt;
    return {
      configuredStatementTimeoutMs: 2_000,
      sleepMs: 2_200,
      databaseOnly,
      competition: {
        requestBudgetMs: REQUEST_BUDGET_MS,
        firstFailure:
          first === 'success'
            ? 'error'
            : first === 'outer_timeout' || first === 'statement_timeout'
              ? first
              : 'error',
        firstFailureElapsedMs,
        eventualDatabaseOutcome: eventualDatabase.outcome,
        eventualDatabaseElapsedMs: eventualDatabase.totalMs,
      },
    };
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validationSchema: envValidationSchema,
        }),
        PrismaModule,
        AccessControlModule,
      ],
    }).compile();
    await moduleFixture.init();
    prisma = moduleFixture.get(PrismaService);
    facade = moduleFixture.get(AccessControlFacade);
    graph = moduleFixture.get<RelationshipGraphPort>(RELATIONSHIP_GRAPH_PORT);

    const originalLoadAudienceFacts = graph.loadAudienceFacts.bind(graph);
    graph.loadAudienceFacts = async (viewerId, targetIds) => {
      const started = performance.now();
      try {
        return await originalLoadAudienceFacts(viewerId, targetIds);
      } finally {
        lastTransactionMs = performance.now() - started;
      }
    };

    await seedUsers();
    await applyBalancedRelationships();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      if (moduleFixture !== undefined) {
        await moduleFixture.close();
      }
    }
  });

  it('records deterministic fixture measurements without timing assertions', async () => {
    if (prisma === undefined) {
      throw new Error('Prisma is not initialized');
    }
    const postgres = await prisma.$queryRaw<
      Array<{ version: string; server_version: string }>
    >`
      SELECT version(), current_setting('server_version') AS server_version
    `;
    const balancedDepths = ids.map((_, index) =>
      depthFor(index, BRANCHING_FACTOR),
    );
    const balancedDepth = Math.max(...balancedDepths);
    const deepestIndexes = balancedDepths
      .map((depth, index) => ({ depth, index }))
      .filter(({ depth }) => depth === balancedDepth)
      .map(({ index }) => index);
    const onePerDepth = Array.from(
      { length: balancedDepth },
      (_, offset) => offset + 1,
    ).map((depth) => balancedDepths.findIndex((value) => value === depth));

    const results: ScenarioResult[] = [];
    results.push(
      await runScenario({
        name: 'balanced-one-target',
        shape: 'balanced',
        hierarchyDepth: balancedDepth,
        viewerIndex: 0,
        targetIndexes: [deepestIndexes[deepestIndexes.length - 1]],
        targetDepths: [balancedDepth],
        expectAllReporting: true,
      }),
    );
    results.push(
      await runScenario({
        name: 'balanced-100-targets',
        shape: 'balanced',
        hierarchyDepth: balancedDepth,
        viewerIndex: 0,
        targetIndexes: deepestIndexes.slice(-100),
        targetDepths: [balancedDepth],
        expectAllReporting: true,
      }),
    );
    results.push(
      await runScenario({
        name: 'balanced-500-targets',
        shape: 'balanced',
        hierarchyDepth: balancedDepth,
        viewerIndex: 0,
        targetIndexes: ids.map((_, index) => index),
        targetDepths: [...new Set(balancedDepths)],
        expectAllReporting: true,
      }),
    );
    results.push(
      await runScenario({
        name: 'viewer-near-top-500-targets',
        shape: 'balanced',
        hierarchyDepth: balancedDepth,
        viewerIndex: 1,
        targetIndexes: ids.map((_, index) => index),
        targetDepths: [...new Set(balancedDepths)],
        expectAllReporting: false,
      }),
    );
    results.push(
      await runScenario({
        name: 'targets-at-different-depths',
        shape: 'balanced',
        hierarchyDepth: balancedDepth,
        viewerIndex: 0,
        targetIndexes: onePerDepth,
        targetDepths: onePerDepth.map((index) => balancedDepths[index]),
        expectAllReporting: true,
      }),
    );

    for (const chainDepth of CHAIN_DEPTHS) {
      await applyChainRelationships(chainDepth);
      results.push(
        await runScenario({
          name:
            chainDepth === FIXTURE_SIZE - 1
              ? 'worst-valid-acyclic-chain'
              : `acyclic-chain-depth-${chainDepth}`,
          shape: 'acyclic_chain',
          hierarchyDepth: chainDepth,
          viewerIndex: 0,
          targetIndexes: ids.map((_, index) => index),
          targetDepths: Array.from(
            { length: Math.min(chainDepth, FIXTURE_SIZE - 1) + 1 },
            (_, depth) => depth,
          ),
          expectAllReporting: true,
        }),
      );
    }

    const timeoutProbe = await runTimeoutProbe();
    const firstBreakingShape =
      results.find(
        (result) =>
          result.firstBudgetBreachMs !== null ||
          result.cold.outcome === 'statement_timeout' ||
          result.warm.outcomes.statement_timeout > 0,
      ) ?? null;
    const cpuModels = [...new Set(cpus().map((cpu) => cpu.model))];
    const generatedAt = new Date().toISOString();
    const report = {
      story: 'P6',
      measurementOnly: true,
      generatedAt,
      reproductionCommand:
        'source "$HOME/.nvm/nvm.sh" && nvm use system && cd services/backend && npm run measure:access-control:p6',
      fixture: {
        size: FIXTURE_SIZE,
        activeUsers: FIXTURE_SIZE,
        branchingFactor: BRANCHING_FACTOR,
        balancedDepth,
        chainDepths: [...CHAIN_DEPTHS],
        deterministicParameters:
          'size=500, branchingFactor=4, chainDepths=25,50,100,200,300,400,499',
      },
      protocol: {
        coldDefinition:
          'First call for a scenario before scenario-specific warm-up; PostgreSQL shared buffers may retain data from earlier scenarios.',
        warmUpMethod:
          'Five identical facade calls discarded before collecting warm samples.',
        warmUpCount: WARM_UP_COUNT,
        sampleCount: SAMPLE_COUNT,
        percentileMethod: 'nearest-rank',
        requestBudgetMs: REQUEST_BUDGET_MS,
        plannerStatistics:
          'ANALYZE relationships ran after each deterministic graph reshape.',
        correctnessGuard:
          'After timing, every target key was required; root-viewer scenarios also required self/reporting for every target.',
      },
      runtime: {
        nodeVersion: process.version,
        nodeVersions: process.versions,
        operatingSystem: {
          platform: platform(),
          release: release(),
          architecture: arch(),
        },
        cpu: {
          availableParallelism: availableParallelism(),
          logicalCores: cpus().length,
          models: cpuModels,
        },
        memoryBytes: {
          total: totalmem(),
          freeAtReportTime: freemem(),
        },
        postgresql: postgres[0],
      },
      timingScope: {
        total:
          'AccessControlFacade.resolveAudiences promise elapsed time measured with performance.now().',
        transaction:
          'RelationshipGraphPort.loadAudienceFacts elapsed time; includes Prisma interactive transaction setup, SET LOCAL, both SQL queries, commit, and result mapping.',
        query:
          'Individual production SQL statement elapsed time was not separately observable without changing production instrumentation.',
      },
      results,
      firstBreakingShape:
        firstBreakingShape === null
          ? null
          : {
              name: firstBreakingShape.name,
              hierarchyDepth: firstBreakingShape.hierarchyDepth,
              targetCount: firstBreakingShape.targetCount,
              firstBudgetBreachMs: firstBreakingShape.firstBudgetBreachMs,
              coldOutcome: firstBreakingShape.cold.outcome,
              warmOutcomes: firstBreakingShape.warm.outcomes,
            },
      timeoutProbe,
      productionCodeChanged: false,
      performanceThresholdAssertionsAdded: false,
    };

    const rows = results
      .map(
        (result) =>
          `| ${result.name} | ${result.shape} | ${result.hierarchyDepth} | ${result.targetCount} | ${result.cold.outcome} / ${result.cold.totalMs.toFixed(3)} | ${formatStats(result.warm.total)} | ${formatStats(result.warm.transaction)} | ${formatStats(result.warm.facadeOverhead)} |`,
      )
      .join('\n');
    const breakingStatement =
      firstBreakingShape === null
        ? 'No tested valid acyclic shape exceeded the two-second total facade-call budget.'
        : `The first tested valid shape to exceed the two-second budget was ${firstBreakingShape.name} at depth ${firstBreakingShape.hierarchyDepth} with ${firstBreakingShape.targetCount} targets.`;
    const timeoutStatement =
      timeoutProbe.competition.firstFailure === 'statement_timeout'
        ? 'PostgreSQL statement_timeout fired before the outer two-second request-budget timer.'
        : 'The outer two-second request-budget timer fired before PostgreSQL statement_timeout; the database cancellation arrived later.';
    const markdown = `# P6 PostgreSQL resolveAudiences measurement

Generated: ${generatedAt}

## Scope and protocol

- Measurement only; no production code or CI timing threshold changed.
- Fixture: ${FIXTURE_SIZE} active synthetic users; balanced branching factor ${BRANCHING_FACTOR}, depth ${balancedDepth}; the same users were deterministically rewired for acyclic chain depths ${CHAIN_DEPTHS.join(', ')}.
- Cold: first call before scenario-specific warm-up. Shared PostgreSQL buffers may remain warm from earlier scenarios.
- Warm-up: ${WARM_UP_COUNT} identical discarded calls. Warm samples: ${SAMPLE_COUNT}. Percentiles: nearest-rank.
- Planner statistics: \`ANALYZE "relationships"\` ran after every graph reshape.
- Untimed correctness guard: every target key was present; root-viewer scenarios required self/reporting for every target.
- Timing values are milliseconds. Columns use p50 / p95 / worst.

## Runtime

- Node: ${process.version}
- OS: ${platform()} ${release()} ${arch()}
- CPU: ${availableParallelism()} available parallelism; ${cpus().length} logical cores; ${cpuModels.join('; ')}
- Memory: ${totalmem()} bytes total; ${freemem()} bytes free at report time
- PostgreSQL server: ${postgres[0].server_version}
- PostgreSQL build: ${postgres[0].version}

## Results

| Scenario | Shape | Depth | Targets | Cold outcome / total ms | Warm total p50 / p95 / worst | Warm transaction p50 / p95 / worst | Warm facade overhead p50 / p95 / worst |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

The transaction measurement is the full RelationshipGraphPort call: interactive transaction setup, SET LOCAL, reporting query, People Partner query, commit, and mapping. Individual production statements are not separately observable without production instrumentation.

${breakingStatement}

## Timeout probe

- Exact command under test: \`SET LOCAL statement_timeout = '2s'\`
- Probe statement: \`SELECT pg_sleep(2.2)\`
- Database-only result: ${timeoutProbe.databaseOnly.outcome} after ${timeoutProbe.databaseOnly.totalMs.toFixed(3)} ms.
- Equal-budget competition: first failure was ${timeoutProbe.competition.firstFailure} after ${timeoutProbe.competition.firstFailureElapsedMs.toFixed(3)} ms; eventual database outcome was ${timeoutProbe.competition.eventualDatabaseOutcome} after ${timeoutProbe.competition.eventualDatabaseElapsedMs.toFixed(3)} ms.
- Conclusion: ${timeoutStatement}

## Reproduction

\`\`\`bash
source "$HOME/.nvm/nvm.sh"
nvm use system
cd services/backend
npm run db:up
npm run db:deploy
npm run measure:access-control:p6
\`\`\`

The benchmark is selected only by \`test/jest-measurement.json\`. Normal \`npm test\` and \`npm run test:e2e\` patterns do not include \`*.measurement-spec.ts\`.

## Generated files

- \`services/backend/test/jest-measurement.json\`
- \`services/backend/test/measurement/resolve-audiences.measurement-spec.ts\`
- \`services/backend/package.json\`
- \`_bmad-output/test-artifacts/performance/p6-resolve-audiences-postgresql.md\`
- \`_bmad-output/test-artifacts/performance/p6-resolve-audiences-postgresql.json\`
`;

    await mkdir(REPORT_DIRECTORY, { recursive: true });
    await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(MARKDOWN_REPORT_PATH, markdown);
  });
});
