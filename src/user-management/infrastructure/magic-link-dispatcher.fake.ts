import { Injectable, Logger } from '@nestjs/common';
import type { MagicLinkDispatcherPort } from '../domain/interfaces/magic-link-dispatcher.port';

// Fixture-backed fake for the outbound magic-link port (AD-3) — a legitimate
// external-integration fake, unlike the interim session/access-control
// adapters below. Epic 2 supplies the real email-sending adapter later.
@Injectable()
export class MagicLinkDispatcherFake implements MagicLinkDispatcherPort {
  private readonly logger = new Logger(MagicLinkDispatcherFake.name);

  async dispatch(workEmail: string): Promise<void> {
    this.logger.log(`Magic-link dispatch (fake) → ${workEmail}`);
    await Promise.resolve();
  }
}
