// Epic 5 Story 5.2 (PM/AD-23) — the frozen participant contract the
// effective-departure apply transaction invokes for every *cross-context*
// effect (Action-Items cancellation, Mentorship auto-close). The signature is
// approved; no participant implements it yet, so `user-management` binds a
// single no-op default (`NoopDepartureEffectsParticipant`). The Action-Items
// and Mentorship contexts each ship a real participant later.
//
// The executor calls this INSIDE its `prisma.$transaction`, handing the
// participant the same unit of work via `tx` — no event bus, no nested
// transaction. `domain/` must not import Prisma, so `tx` is an opaque handle
// here; the infrastructure participant narrows it to `Prisma.TransactionClient`.

export type DepartureEffectsTransaction = unknown;

export interface ApplyDepartureEffectsInput {
  departureId: string;
  departingUserId: string;
  /** `00:00` on the effective date in `effectiveTimeZone`, as stored. */
  effectiveDate: Date;
  /** The claiming executor's fencing token — a participant that spawns its own
   *  writes must predicate them so a stale executor cannot double-apply. */
  leaseToken: string;
  tx: DepartureEffectsTransaction;
}

export interface DepartureEffectsParticipant {
  applyDepartureEffects(input: ApplyDepartureEffectsInput): Promise<void>;
}

export const DEPARTURE_EFFECTS_PORT = Symbol('DEPARTURE_EFFECTS_PORT');
