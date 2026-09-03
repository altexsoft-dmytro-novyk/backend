import * as Joi from 'joi';
import { checkCorsOriginsCsv } from './cors-origins';
import {
  DEFAULT_LOG_LEVELS_CSV,
  checkLogLevelsCsv,
} from '../common/logging/log-levels';

// Epic 5 Story 5.1 (AD-20) — the business day boundary for resolving a
// `Departure.dueAt` (`00:00` on the effective date in this zone, snapshotted
// once to `effectiveTimeZone`). Required, no UTC fallback: a wrong or missing
// zone silently shifts every scheduled cutoff, so the app must fail fast at
// startup. Validated as a real IANA zone — `Intl.DateTimeFormat` throws
// `RangeError` on an unknown identifier.
const ianaTimeZone: Joi.CustomValidator<string> = (value, helpers) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return helpers.error('any.invalid');
  }
};

export const envValidationSchema = Joi.object({
  BUSINESS_TIME_ZONE: Joi.string()
    .required()
    .custom(ianaTimeZone, 'IANA time zone'),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3001),
  // Comma-separated subset of the Nest console log levels (see
  // `common/logging/log-levels.ts`) — `main.ts` passes the parsed list to
  // `app.useLogger()`. Not a threshold: list every level you want emitted.
  LOG_LEVELS: Joi.string()
    .default(DEFAULT_LOG_LEVELS_CSV)
    .custom(
      (value: string, helpers) =>
        checkLogLevelsCsv(value) === null
          ? value
          : helpers.error('any.invalid'),
      'comma-separated Nest log levels',
    ),
  // A comma-separated list of allowed origins (see `config/cors-origins.ts` and
  // `main.ts`), e.g. `http://localhost:4200,https://app.example`. Each entry is
  // a bare origin — `scheme://host[:port]`, no path or trailing slash.
  CORS_ORIGIN: Joi.string()
    .default('http://localhost:4200')
    .custom(
      (value: string, helpers) =>
        checkCorsOriginsCsv(value) === null
          ? value
          : helpers.error('any.invalid'),
      'comma-separated bare origins',
    ),
  DATABASE_URL: Joi.string().required(),
  // `tlds:false` — the codebase uses RFC-2606 `*.example` placeholders (and CI
  // has no real mailbox), so validate the `local@domain.tld` shape but not the
  // TLD against the IANA list (`.example` is not on it). A default value is
  // trusted unvalidated, so this only bites when the var is set in `.env`.
  ROOT_WORK_EMAIL: Joi.string()
    .email({ tlds: { allow: false } })
    .default('root@company.example'),
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_S3_BUCKET: Joi.string().default('user-management-photos'),
  // Set for LocalStack (local dev/CI); unset in prod to use real AWS endpoints.
  AWS_ENDPOINT_URL: Joi.string().uri().optional(),
  AWS_ACCESS_KEY_ID: Joi.string().default('test'),
  AWS_SECRET_ACCESS_KEY: Joi.string().default('test'),

  // Epic 2 — Magic-Link Authentication (Story 2.1).
  // Token lifetime (DEC-UM-004: configuration-owned). Story 2.1 asserts only
  // `expiresAt > now()`; the exact figure is exercised by Story 2.2's expiry test.
  MAGIC_LINK_TTL_MINUTES: Joi.number().integer().positive().default(15),
  // Base URL the emailed magic link points at (the `/auth/magic-link/consume`
  // route itself is Story 2.2 — this only fixes the link shape).
  APP_BASE_URL: Joi.string().uri().default('http://localhost:4200'),
  // Outbound email transport for the real magic-link dispatcher (nodemailer/SMTP).
  // AD-15: the real adapter is Epic 2's deliverable, pointed at whatever local
  // infra the developer's env provides — no dev-infra container in compose.
  MAIL_HOST: Joi.string().default('localhost'),
  MAIL_PORT: Joi.number().port().default(1025),
  MAIL_SECURE: Joi.boolean().default(false),
  MAIL_USER: Joi.string().allow('').default(''),
  MAIL_PASSWORD: Joi.string().allow('').default(''),
  // Not `.email()` — nodemailer's `from` also takes the RFC 5322 display-name
  // form `Name <local@domain>`, which a bare-addr-spec validator rejects.
  MAIL_FROM: Joi.string().min(3).default('no-reply@company.example'),

  // Epic 2 — Magic-Link Authentication (Story 2.2 — session establishment).
  // Session token = stateless HS256 JWT (auth/README decision 10); no `Session`
  // table. The secret is required in production and has a dev-only default
  // elsewhere so local/CI/test boot without extra setup.
  SESSION_JWT_SECRET: Joi.string()
    .min(16)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default(
        'dev-only-insecure-session-secret-change-me',
      ),
    }),
  // Session lifetime in hours (auth/README decision 11 — a single work day;
  // `expiresIn` in the 200 body is this × 3600 seconds).
  SESSION_TTL_HOURS: Joi.number().integer().positive().default(8),
  // Non-prod escape hatch: when true, the real SessionResolver ALSO accepts the
  // `Bearer <token:<persona>>` e2e/fixture shorthand (auth/README decision 12 —
  // the retired interim adapter's capability, folded in behind a flag). Refused
  // when NODE_ENV=production so AD-21's "one adapter" holds.
  ALLOW_TEST_SESSION_TOKENS: Joi.boolean().when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),

  // Epic 5 Story 5.2 (AD-20) — the effective-departure application worker.
  // `DEPARTURE_WORKER_ENABLED` has NO default: the mixed-process-config startup
  // check requires every process to declare an explicit `true` / `false` so an
  // operator can diff the effective worker topology (um-dep-03 decision 6). When
  // `false` the `@Interval` polling loop is not registered; the injectable
  // `DepartureWorkerService.processDueDepartures()` seam is still callable (the
  // E2E drives it directly — DEC-UM-004).
  DEPARTURE_WORKER_ENABLED: Joi.boolean().required(),
  // Poll cadence for the DB-polling claim loop. Date-granular departures make a
  // minute of materialisation lag immaterial (the request-time cutoff is
  // independent and immediate); floor at 1s so a misconfiguration cannot busy-loop.
  DEPARTURE_WORKER_POLL_MS: Joi.number().integer().min(1000).default(60000),
});
