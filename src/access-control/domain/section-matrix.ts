import { AccessLevel, Audience, SectionId } from './types';

// AD-11: the base section-access matrix is a versioned code constant, not a
// DB table. Sourced from docs/project-requirements.md §3.2. `project` values
// are encoded for future-correctness (AD-12's matrix column is structurally
// present) but Phase 1's audience resolver never emits 'project' — see
// domain/services/audience-resolver.service.ts — so these cells are inert
// until the Project-line resolver pass is approved.
//
// Cells that carry a documented per-command exception (S1 photo, S5
// certificate upload, S12 own-IDP-complete, S13 own-flag, S14 own-complete)
// are NOT encoded here — the matrix expresses the *section-level* default;
// the narrower/wider per-command exceptions are implemented as explicit,
// separate checks in the application layer next to the route that needs
// them, exactly as §3.2's footnotes and §4.3 describe them.
export const SECTION_MATRIX: Record<
  SectionId,
  Record<Audience, AccessLevel>
> = {
  s1: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'read',
  },
  s2: {
    self: 'write',
    reporting: 'read',
    project: 'none',
    pp: 'write',
    colleague: 'none',
  },
  s3: {
    self: 'write',
    reporting: 'read',
    project: 'none',
    pp: 'write',
    colleague: 'none',
  },
  s4: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s5: {
    self: 'read',
    reporting: 'read',
    project: 'read',
    pp: 'write',
    colleague: 'none',
  },
  s6: {
    self: 'none',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s7: {
    self: 'read',
    reporting: 'write',
    project: 'read',
    pp: 'write',
    colleague: 'none',
  },
  s8: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s9: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s10: {
    self: 'read',
    reporting: 'read',
    project: 'read',
    pp: 'read',
    colleague: 'read',
  },
  s11: {
    self: 'read',
    reporting: 'read',
    project: 'read',
    pp: 'read',
    colleague: 'read',
  },
  s12: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s13: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s14: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'none',
  },
  s15: {
    self: 'none',
    reporting: 'read',
    project: 'read',
    pp: 'read',
    colleague: 'none',
  },
  s16: {
    self: 'read',
    reporting: 'write',
    project: 'write',
    pp: 'write',
    colleague: 'read',
  },
};

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

/** AD-14: best-of merge, write > read > none. */
export function mergeAccessLevels(levels: AccessLevel[]): AccessLevel {
  let best: AccessLevel = 'none';
  for (const level of levels) {
    if (RANK[level] > RANK[best]) best = level;
  }
  return best;
}
