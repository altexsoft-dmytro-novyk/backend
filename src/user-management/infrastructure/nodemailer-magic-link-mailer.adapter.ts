import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type {
  MagicLinkDeliveryResult,
  MagicLinkMailerPort,
} from '../domain/interfaces/magic-link-mailer.port';

// AD-21 companion: the real magic-link email adapter. Builds the sign-in link
// as `${APP_BASE_URL}/auth/callback?token=<raw>` and sends it over SMTP via
// nodemailer, using the plain SMTP_* transport config.
//
// Safe by default: with no SMTP_HOST configured, or under NODE_ENV=test, it
// logs the link and returns 'sent' without opening a socket — so the e2e
// suite and a bare local run never hang on a missing mail server.
@Injectable()
export class NodemailerMagicLinkMailer implements MagicLinkMailerPort {
  private readonly logger = new Logger(NodemailerMagicLinkMailer.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  async deliver(input: {
    workEmail: string;
    rawToken: string;
  }): Promise<MagicLinkDeliveryResult> {
    const link = this.buildLink(input.rawToken);
    const transporter = this.getTransporter();

    if (!transporter) {
      this.logger.log(
        `magic-link (no SMTP configured) for ${input.workEmail}: ${link}`,
      );
      return 'sent';
    }

    try {
      await transporter.sendMail({
        from: this.config.get<string>('SMTP_FROM'),
        to: input.workEmail,
        subject: 'Your sign-in link',
        text: `Sign in to the People Platform:\n\n${link}\n\nThis link is valid for 15 minutes. If you didn't request it, ignore this email.`,
        html: `<p>Sign in to the People Platform:</p><p><a href="${link}">${link}</a></p><p>This link is valid for 15 minutes. If you didn't request it, ignore this email.</p>`,
      });
      return 'sent';
    } catch (error) {
      this.logger.error(
        `magic-link delivery to ${input.workEmail} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      return 'failed';
    }
  }

  private buildLink(rawToken: string): string {
    const base = (
      this.config.get<string>('APP_BASE_URL') ?? 'http://localhost:4200'
    ).replace(/\/+$/, '');
    return `${base}/auth/callback?token=${encodeURIComponent(rawToken)}`;
  }

  private getTransporter(): Transporter | null {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host || this.config.get<string>('NODE_ENV') === 'test') {
      return null;
    }
    if (!this.transporter) {
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASSWORD');
      this.transporter = createTransport({
        host,
        port: this.config.get<number>('SMTP_PORT') ?? 587,
        secure: this.config.get<boolean>('SMTP_SECURE') ?? false,
        auth: user && pass ? { user, pass } : undefined,
      });
    }
    return this.transporter;
  }
}
