import { createHash } from 'node:crypto';
import type { PlatformBlockerSet } from '../interfaces/departure.repository.port';

// Pure Story 5.1 domain rules — no Prisma, NestJS, or HTTP. `node:crypto` is the
// Node standard library (the accepted pattern already used by `magic-link.service.ts`
// and `access-journal-idempotency.ts`).

/** `reason` normalization before hashing: trim + collapse internal whitespace.
 *  No case fold — `reason` is human prose (um-dep-06 scenario-stage decision). */
export function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, ' ');
}

/** ISO date normalization — a bare `YYYY-MM-DD`, dropping any time part. */
export function normalizeEffectiveDate(effectiveDate: string): string {
  return effectiveDate.slice(0, 10);
}

/** Canonical `requestHash` (database-schema.md §Departure / api-conventions.md):
 *  API contract version, path user id, normalized ISO effective date, normalized
 *  reason, authenticated creator id. NOT the `Idempotency-Key` and NOT the wall
 *  clock. */
export function computeRequestHash(input: {
  userId: string;
  effectiveDate: string;
  reason: string;
  creatorId: string;
}): string {
  const canonical = JSON.stringify([
    'departures.v1',
    input.userId,
    normalizeEffectiveDate(input.effectiveDate),
    normalizeReason(input.reason),
    input.creatorId,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The opaque `expectedBlockerVersion` digest (um-dep-02 scenario-stage decision):
 * `"v1:" + base64url(sha256(JSON.stringify({ userId, blockers: <sorted tuples> })))`.
 * Tuples are `{ kind, ref }` sorted by `(kind, ref)` where `ref` is the
 * `relationshipId` for `direct_report` / `people_partner` and the `Policies.id`
 * for `department_manager`. `external_pm_dm` is excluded — the re-parent command
 * cannot mutate it. The `userId` prefix stops a digest being replayed across
 * people.
 */
export function computeExpectedBlockerVersion(
  userId: string,
  set: PlatformBlockerSet,
): string {
  const tuples: Array<{ kind: string; ref: string }> = [
    ...set.directReports.map((r) => ({
      kind: 'direct_report',
      ref: r.relationshipId,
    })),
    ...(set.departmentManager
      ? [{ kind: 'department_manager', ref: set.departmentManager.policyId }]
      : []),
    ...set.peoplePartnerAssignments.map((r) => ({
      kind: 'people_partner',
      ref: r.relationshipId,
    })),
  ].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.ref === b.ref) return 0;
    return a.ref < b.ref ? -1 : 1;
  });
  const canonical = JSON.stringify({ userId, blockers: tuples });
  return `v1:${createHash('sha256').update(canonical).digest('base64url')}`;
}

export function hasPlatformBlockers(set: PlatformBlockerSet): boolean {
  return (
    set.directReports.length > 0 ||
    set.departmentManager !== null ||
    set.peoplePartnerAssignments.length > 0
  );
}

/** The leak-safe `409` body for a blocked recording. Identities are included
 *  only for blockers the caller may administer; the acting session already
 *  holds `employee:departure:record` (an HR action), so all platform blockers
 *  are itemised here — narrowing to `org:relationships:write` / full-access
 *  holders is a tracked follow-up. */
export function buildBlockedResponse(
  userId: string,
  set: PlatformBlockerSet,
): Record<string, unknown> {
  const blockers: Array<Record<string, unknown>> = [];

  if (set.directReports.length > 0) {
    const n = set.directReports.length;
    blockers.push({
      kind: 'direct_report',
      summary: `Manages ${n} direct report${n === 1 ? '' : 's'}`,
      targets: set.directReports.map((r) => ({
        userId: r.reportUserId,
        name: r.reportName,
      })),
    });
  }

  if (set.departmentManager) {
    blockers.push({
      kind: 'department_manager',
      summary: `Manages department '${set.departmentManager.departmentName}'`,
      departmentId: set.departmentManager.departmentId,
      departmentName: set.departmentManager.departmentName,
    });
  }

  if (set.peoplePartnerAssignments.length > 0) {
    const n = set.peoplePartnerAssignments.length;
    blockers.push({
      kind: 'people_partner',
      summary: `Assigned People Partner for ${n} person${n === 1 ? '' : 's'}`,
      targets: set.peoplePartnerAssignments.map((r) => ({
        userId: r.partneredUserId,
        name: r.partneredName,
      })),
    });
  }

  const body: Record<string, unknown> = {
    error: 'departure_blocked_by_responsibilities',
    blockers,
    expectedBlockerVersion: computeExpectedBlockerVersion(userId, set),
  };
  if (set.ownDirectManagerId) {
    body.defaultReparentTargetId = set.ownDirectManagerId;
  }
  return body;
}

/**
 * The UTC instant of `00:00` local time on `effectiveDate` in `timeZone`.
 * Computed from the zone's offset via `Intl` — never from host/runtime local
 * time (database-schema.md §Departure). Two-pass fixpoint covers the offset
 * used at the resolved instant.
 */
export function resolveDueAtUtc(effectiveDate: string, timeZone: string): Date {
  const [year, month, day] = normalizeEffectiveDate(effectiveDate)
    .split('-')
    .map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let instant = wallClockUtc - zoneOffsetMs(wallClockUtc, timeZone);
  instant = wallClockUtc - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

/** `localWallClock(instant, zone) - instant`, in ms. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const p: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour === 24 ? 0 : p.hour,
    p.minute,
    p.second,
  );
  return asUtc - instant;
}
