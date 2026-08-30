// Shared vocabulary for the AccessControl facade domain layer. Pure types —
// no Prisma, no NestJS, per AD-1.

/**
 * §3.1 audiences. Phase 1 (this build) resolves Self, Reporting line, PP,
 * and Colleague live. Project line is structurally present (AD-12's matrix
 * column exists) but Phase 1 withholds the positive resolver pass per the
 * facade SPEC's Constraints and the test-case suite's own scoping — no
 * caller ever receives 'project' from the audience resolver in this build.
 */
export type Audience = 'self' | 'reporting' | 'project' | 'pp' | 'colleague';

/** none/read/write — the only three cell values in the §3.2 matrix. */
export type AccessLevel = 'none' | 'read' | 'write';

/** S1..S16, per §3.2. */
export type SectionId =
  | 's1'
  | 's2'
  | 's3'
  | 's4'
  | 's5'
  | 's6'
  | 's7'
  | 's8'
  | 's9'
  | 's10'
  | 's11'
  | 's12'
  | 's13'
  | 's14'
  | 's15'
  | 's16';

export interface ViewerContext {
  actorId: string;
}
