import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { DepartureMetricsService } from '../../infrastructure/departure-metrics.service';

// Epic 5 Story 5.2 (AD-20) — the operator health surface for the
// effective-departure worker. Unauthenticated, like the existing
// `/api/v1/health` (no `@UseGuards`). LIVE subset only: plain counters computed
// from `departures` + the two in-process tallies. Alert thresholds, paging, and
// the observability-vendor push stay DEFERRED (the vendor is Deferred per AD-20).
@Controller('health')
export class DepartureHealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: DepartureMetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get('departures')
  async departures(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        oldestDueLagSeconds: number | string | null;
        retryWaitCount: number | string | bigint | null;
        processingCount: number | string | bigint | null;
      }>
    >(
      `SELECT
         COALESCE(GREATEST(EXTRACT(EPOCH FROM (now() - MIN("dueAt"))), 0), 0) AS "oldestDueLagSeconds",
         COUNT(*) FILTER (WHERE state = 'retry_wait') AS "retryWaitCount",
         COUNT(*) FILTER (WHERE state = 'processing') AS "processingCount"
       FROM "departures"
       WHERE state <> 'applied'`,
    );
    const row = rows[0];

    return {
      oldestDueLagSeconds: Math.round(Number(row?.oldestDueLagSeconds ?? 0)),
      retryWaitCount: Number(row?.retryWaitCount ?? 0),
      processingCount: Number(row?.processingCount ?? 0),
      reclaimedLeaseCount: this.metrics.reclaimedLeaseCount,
      requestTimeCutoffDenialsTotal: this.metrics.requestTimeCutoffDenialsTotal,
      workerConfig: {
        enabled: this.config.getOrThrow<boolean>('DEPARTURE_WORKER_ENABLED'),
        businessTimeZone: this.config.getOrThrow<string>('BUSINESS_TIME_ZONE'),
        pollMs: this.config.getOrThrow<number>('DEPARTURE_WORKER_POLL_MS'),
      },
    };
  }
}
