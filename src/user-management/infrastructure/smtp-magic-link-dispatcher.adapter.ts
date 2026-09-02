import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MagicLinkDispatcherPort } from '../domain/interfaces/magic-link-dispatcher.port';

/**
 * Epic 2 Story 2.1 — the real outbound magic-link dispatcher (AD-15: email
 * delivery is a legitimately external integration, but the real adapter is this
 * epic's own deliverable). nodemailer/SMTP, configured entirely from env
 * (`MAIL_*` / `APP_BASE_URL`), pointed at whatever transactional-email service
 * or local SMTP the environment provides — no dev-infra container in compose
 * (testing-strategy.md AD-15). The E2E rebinds this port to a recording fake.
 *
 * NFR-3: a delivery failure must never crash the request or leak an
 * account-existence signal — `dispatch` catches every transport error, logs it,
 * and resolves. The caller has already persisted the token and returns the same
 * generic body regardless.
 */
@Injectable()
export class SmtpMagicLinkDispatcherAdapter implements MagicLinkDispatcherPort {
  private readonly logger = new Logger(SmtpMagicLinkDispatcherAdapter.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly appBaseUrl: string;

  constructor(config: ConfigService) {
    this.from = config.getOrThrow<string>('MAIL_FROM');
    this.appBaseUrl = config.getOrThrow<string>('APP_BASE_URL');

    const user = config.get<string>('MAIL_USER');
    const pass = config.get<string>('MAIL_PASSWORD');
    this.transporter = createTransport({
      host: config.getOrThrow<string>('MAIL_HOST'),
      port: config.getOrThrow<number>('MAIL_PORT'),
      secure: config.getOrThrow<boolean>('MAIL_SECURE'),
      auth: user ? { user, pass } : undefined,
    });
  }

  async dispatch(workEmail: string, token: string): Promise<void> {
    // The `/auth/magic-link/consume` route is Story 2.2 — this only fixes the
    // link shape.
    const link = `${this.appBaseUrl}/auth/magic-link/consume?token=${encodeURIComponent(
      token,
    )}`;

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: workEmail,
        subject: 'Your sign-in link',
        text: `Use this link to sign in (it expires shortly): ${link}`,
        html: `<p>Use this link to sign in (it expires shortly):</p><p><a href="${link}">${link}</a></p>`,
      });
    } catch (error) {
      // NFR-3: swallow after logging. Do not echo the address — the log line
      // must not become an enumeration oracle.
      this.logger.warn(`magic-link dispatch failed: ${String(error)}`);
    }
  }
}
