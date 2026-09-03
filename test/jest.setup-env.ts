// e2e-only environment defaults. Mirrors how `ALLOW_TEST_SESSION_TOKENS`-style
// non-prod knobs are handled: the real `AppModule` fails fast on a missing /
// invalid `BUSINESS_TIME_ZONE` (Epic 5 Story 5.1, `env.validation.ts`), and the
// e2e bootstrap boots that real module against `.env` — which does not carry the
// new var yet (the harness blocks `.env*` edits; the coordinator hands the user
// the block). `??=` never overrides a real value from the environment or `.env`.
process.env.BUSINESS_TIME_ZONE ??= 'Europe/London';

// Epic 5 Story 5.2 — the effective-departure worker. E2E invokes
// `DepartureWorkerService.processDueDepartures()` directly (DEC-UM-004), so the
// `@Interval` polling loop stays off and never races the explicit call. The
// `.env` the real `AppModule` boots against does not carry these yet (the
// harness blocks `.env*` edits; the coordinator hands the user the block).
// `??=` never overrides a real value from the environment or `.env`.
process.env.DEPARTURE_WORKER_ENABLED ??= 'false';
process.env.DEPARTURE_WORKER_POLL_MS ??= '60000';
