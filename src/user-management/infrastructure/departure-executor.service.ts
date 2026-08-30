import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

// AD-16: the departure executor. A NestJS scheduled task polls for due,
// unapplied Departures (`effectiveDate <= now() AND appliedAt IS NULL`)
// using `SELECT ... FOR UPDATE SKIP LOCKED` — raw SQL, since Prisma's typed
// client has no SKIP LOCKED support (open upstream limitation as of Prisma
// 7) — and applies the full Story 5.2 side-effect bundle in one transaction
// per due row. `appliedAt` gates re-selection, so a retry after a partial
// failure (transaction rolled back, appliedAt still null) re-attempts the
// whole bundle cleanly — atomicity alone gives idempotency across retries.
// Each side-effect statement is additionally a conditional
// `UPDATE ... WHERE <open-state predicate>` (never a blind update by id) so
// a concurrent human edit made moments earlier (e.g. a manager writing a
// closure note) is treated as already-satisfied, not clobbered or
// re-applied — the "concurrent-human-write guard" the spine calls out.
//
// This is infrastructure, not domain/ (AD-1): it is the entry point NestJS'
// scheduler drives, directly against Prisma, the same way a controller is
// the entry point HTTP drives — there is no port to inject here because
// nothing else in this bounded context needs to call "apply due
// departures," only the clock does.
@Injectable()
export class DepartureExecutorService {
  private readonly logger = new Logger(DepartureExecutorService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    await this.runOnce();
  }

  /**
   * Applies every currently-due, unapplied Departure, one per transaction,
   * looping until `SELECT ... FOR UPDATE SKIP LOCKED` finds none left.
   * Exposed as a plain method (rather than only the @Cron hook) so e2e
   * tests can invoke it deterministically instead of waiting on the clock.
   */
  async runOnce(): Promise<number> {
    let applied = 0;

    while (true) {
      const didApply = await this.applyNextDue();
      if (!didApply) break;
      applied += 1;
    }
    return applied;
  }

  private async applyNextDue(): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM departures
        WHERE effective_date <= now() AND applied_at IS NULL
        ORDER BY effective_date
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (claimed.length === 0) return false;
      const { id: departureId, user_id: userId } = claimed[0];

      // 1. EmploymentStatus: close the open active row, open a dismissed
      // one (AD-18 append-only — never an in-place status flip).
      await tx.$executeRaw`
        UPDATE employment_statuses SET end_date = now()
        WHERE user_id = ${userId}::uuid AND status = 'active' AND end_date IS NULL
      `;
      const openDismissed = await tx.employmentStatus.findFirst({
        where: { userId, status: 'dismissed', endDate: null },
        select: { id: true },
      });
      if (!openDismissed) {
        await tx.employmentStatus.create({
          data: { userId, status: 'dismissed', startDate: new Date() },
        });
      }

      // 2. User.isActive = false, conditional so a concurrent write isn't
      // blindly overwritten.
      await tx.$executeRaw`
        UPDATE users SET is_active = false
        WHERE id = ${userId}::uuid AND is_active = true
      `;

      // 3. Open S14 action items -> "cancelled — departed", skipping any
      // already completed or already cancelled by a human moments earlier.
      await tx.$executeRaw`
        UPDATE section_records
        SET data = jsonb_set(data, '{status}', '"cancelled — departed"')
        WHERE section = 's14'
          AND data->>'assigneeId' = ${userId}
          AND data->>'status' NOT IN ('completed', 'cancelled — departed')
      `;

      // 4. Active S13 mentorship pairs (this user as mentor or mentee) ->
      // closed with a system note, skipping any already closed.
      await tx.$executeRaw`
        UPDATE section_records
        SET data = data || jsonb_build_object(
          'status', 'closed',
          'closureNote', 'system: employee departed'
        )
        WHERE section = 's13'
          AND data->>'kind' = 'pair'
          AND (data->>'mentorId' = ${userId} OR data->>'menteeId' = ${userId})
          AND COALESCE(data->>'status', 'active') != 'closed'
      `;

      // 5. Mark applied — same transaction, conditional on still-unapplied
      // (defensive; the FOR UPDATE SKIP LOCKED claim already guarantees
      // this, but the WHERE keeps the statement correct even if that ever
      // changes).
      await tx.$executeRaw`
        UPDATE departures SET applied_at = now()
        WHERE id = ${departureId}::uuid AND applied_at IS NULL
      `;

      this.logger.log(`Applied departure ${departureId} for user ${userId}`);
      return true;
    });
  }
}
