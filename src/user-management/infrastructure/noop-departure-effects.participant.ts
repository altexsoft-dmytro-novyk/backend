import { Injectable, Logger } from '@nestjs/common';
import type {
  ApplyDepartureEffectsInput,
  DepartureEffectsParticipant,
} from '../domain/interfaces/departure-effects.port';

// Epic 5 Story 5.2 (PM/AD-23) — the default binding for `DEPARTURE_EFFECTS_PORT`.
//
// This is NOT a stub of participant behaviour: the `applyDepartureEffects`
// signature is frozen and the executor's call site is real, but the two
// participant contexts (Action-Items cancellation, Mentorship auto-close) do
// not exist yet, so the contract has zero participants and the call does
// nothing. When `action-items` / `mentorship` ship, each registers its own
// participant and this no-op is composed alongside (or replaced by) them.
@Injectable()
export class NoopDepartureEffectsParticipant implements DepartureEffectsParticipant {
  private readonly logger = new Logger(NoopDepartureEffectsParticipant.name);

  applyDepartureEffects(input: ApplyDepartureEffectsInput): Promise<void> {
    this.logger.debug(
      `applyDepartureEffects: no participants registered (departureId=${input.departureId})`,
    );
    return Promise.resolve();
  }
}
