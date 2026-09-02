import { Injectable, Logger } from '@nestjs/common';
import type { MagicLinkDispatcherPort } from '../domain/interfaces/magic-link-dispatcher.port';

// Dev/non-test no-op fake for the outbound magic-link port. Retained for local
// runs that don't want a real SMTP transport; production wires the real
// `SmtpMagicLinkDispatcherAdapter` and the E2E rebinds its own recording fake.
// Not wired anywhere by default (Story 2.1).
@Injectable()
export class MagicLinkDispatcherFake implements MagicLinkDispatcherPort {
  private readonly logger = new Logger(MagicLinkDispatcherFake.name);

  // A narrower parameter list still satisfies the widened port contract.
  async dispatch(workEmail: string): Promise<void> {
    this.logger.log(`Magic-link dispatch (fake) → ${workEmail}`);
    await Promise.resolve();
  }
}
