/**
 * PLAT-E4-S4.1a (SCP sprint-change-proposal-2026-09-04-section-access-consolidation.md
 * D2) — per-person section-write keys every active user implicitly holds, with
 * no `Policies`/`PolicyPermissions`/`UserPolicies` row. Add a key only when a
 * route actually consumes it; narrowing a section means removing its key here
 * and granting it explicitly to a tighter FR role instead.
 */
export const DEFAULT_PERMISSIONS: ReadonlySet<string> = new Set([
  'profile:identity:write',
]);
