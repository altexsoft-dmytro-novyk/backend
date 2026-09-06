// The resolved section-access level, declared UM-locally. It is structurally
// the kernel's `SectionAccess`, but deliberately NOT imported from
// `src/access-control/` — a domain-side port must not reach across the AD-2
// boundary; only `infrastructure/` may (nestjs-di-tokens.md:62).
export type SectionAccessLevel = 'none' | 'read' | 'write';

// What a route may require. `'none'` is a resolved answer, never a
// requirement — a gate that required `'none'` would gate nothing.
export type SectionAccessRequirement = 'read' | 'write';

export interface AccessControlPort {
  isAllowed(userId: string, feature: string): Promise<boolean>;
  isAllowedForTarget(
    userId: string,
    feature: string,
    targetUserId: string,
  ): Promise<boolean>;
  /**
   * The one question every section-gated route asks (SCP 2026-09-04 D3):
   * does this viewer reach `level` on `section` of `targetUserId`?
   *
   * Satisfaction is by RANK, not equality — `write` satisfies a `'read'`
   * requirement, `none` satisfies neither. A `'write'` requirement is the D1
   * dual gate and is AUDIENCE-FIRST: the resolved audience half decides first
   * and the functional half is consulted only afterwards, so a functional
   * permission can only ever subtract (`docs/architecture/access-control.md:19`,
   * NORMATIVE). A `'read'` requirement has no functional half at all.
   *
   * Fail-closed: a section with no matrix row resolves `none` → `false`, with
   * no throw and no log-and-allow.
   */
  hasSectionAccess(
    userId: string,
    section: string,
    level: SectionAccessRequirement,
    targetUserId: string,
  ): Promise<boolean>;
}

export const ACCESS_CONTROL_PORT = Symbol('ACCESS_CONTROL_PORT');
