import { Injectable } from '@nestjs/common';
import type {
  MagicLinkDeliveryResult,
  MagicLinkMailerPort,
} from '../../../src/user-management/domain/interfaces/magic-link-mailer.port';

export interface RecordedMail {
  workEmail: string;
  rawToken: string;
}

// Recording fake for the magic-link mailer — the "email-adapter fake" the
// um-auth-* scenarios assert against. Every `deliver` call is captured;
// `nextResult` lets a test drive the transport-failure branch.
@Injectable()
export class RecordingMagicLinkMailer implements MagicLinkMailerPort {
  readonly sent: RecordedMail[] = [];
  nextResult: MagicLinkDeliveryResult = 'sent';

  deliver(input: {
    workEmail: string;
    rawToken: string;
  }): Promise<MagicLinkDeliveryResult> {
    this.sent.push({ ...input });
    return Promise.resolve(this.nextResult);
  }

  reset(): void {
    this.sent.length = 0;
    this.nextResult = 'sent';
  }
}
