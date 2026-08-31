// Epic 2 outbound port: delivers the sign-in link produced by a freshly
// minted magic-link token. The adapter owns the link shape and the transport;
// callers pass only the recipient and the raw token.
//
// Delivery is best-effort by contract — an implementation must not throw for a
// transport failure; it resolves either way and reports the outcome so the
// caller can record it on MagicLinkToken.dispatchStatus (NFR-3: an email
// outage never turns POST /auth/magic-link into a non-200).
export interface MagicLinkMailerPort {
  deliver(input: {
    workEmail: string;
    rawToken: string;
  }): Promise<MagicLinkDeliveryResult>;
}

export type MagicLinkDeliveryResult = 'sent' | 'failed';

export const MAGIC_LINK_MAILER_PORT = Symbol('MAGIC_LINK_MAILER_PORT');
