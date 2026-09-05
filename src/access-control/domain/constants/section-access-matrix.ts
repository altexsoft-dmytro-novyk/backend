import type { Audience } from '../audience';

/**
 * PLAT-E4-S4.1b — base per-section access by audience (CAP-5, §3.2). A new
 * section is a new row here, never a new branch in
 * `AccessControlFacade.resolveSectionAccess`. Rows below are byte-identical
 * to the pre-rename hardcoded `'S1'`/`'S10'`/`'S11'` branches; an audience
 * missing from a row denies (`'none'`), same as every other absent-cell case.
 */
export type SectionAccessLevel = 'none' | 'read' | 'write';

export const SECTION_ACCESS_MATRIX: Readonly<
  Record<string, Partial<Record<Audience, SectionAccessLevel>>>
> = {
  'profile:identity': {
    self: 'read',
    colleague: 'read',
    reporting: 'write',
    pp: 'write',
  },
  'profile:leave': {
    self: 'read',
    colleague: 'read',
    reporting: 'read',
    pp: 'read',
  },
  'profile:projects': {
    self: 'read',
    colleague: 'read',
    reporting: 'read',
    pp: 'read',
  },
};
