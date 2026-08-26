---
paths:
  - "test/**"
---

# E2E Testing Conventions

- Files: `test/<area>.e2e-spec.ts`; run with `npm run test:e2e` against the REAL Postgres from docker (`npm run db:up` first)
- Build the app from `AppModule` via `Test.createTestingModule`

## Bootstrap config is NOT inherited

`main.ts` settings (global `/api` prefix, versioning, pipes) do not apply to the test app:

- Routes are unprefixed in e2e: request `/users`, not `/api/v1/users`
- Re-enable the pipe manually, mirroring main.ts:
  `app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`

## Data isolation

- Unique test values with a run prefix: `` const emailPrefix = `e2e-${Date.now()}` ``
- Clean up in `afterAll`: `prisma.user.deleteMany({ where: { email: { startsWith: emailPrefix } } })`, then `await app.close()`

## Style

- `import request from 'supertest'` — default import (namespace import is not callable under esModuleInterop)
- Type response bodies explicitly: `const body = res.body as UserEntity`
- Cover the full flow including error codes (409 duplicate, 400 validation, 404 missing) — see `test/users.e2e-spec.ts`

## Preconditions must be real, not assumed

A scenario doc's precondition ("Given Alice, an existing user...", "Nina's `User` row is created by `um-reg-01`, which is the trigger") describes state the test must actually produce — never a hardcoded placeholder standing in for state that was never created. Each e2e file (and, within it, `it`s in declaration order) is all the state you get: nothing from another file's run persists or can be relied on.

- **If the precondition is producible through an endpoint this suite covers** (create a user via `POST /users`, edit a field via `PATCH /users/:id`, add an event via `POST /users/:id/events`, …), the test must make that real request and use the *real* value it returns (`id`, etc.) for every later step — never a literal `<aliceId>`/`<ninaId>` path segment. Do this even before the endpoint exists: the call 404s today and starts returning real data the moment the story lands. A test built on a hardcoded placeholder id can never go green even after correct implementation — that's the whole reason for this rule.
- **If the precondition is delivered exclusively out-of-band with no HTTP-observable seam** (a magic-link token sent by email, with no endpoint that echoes it back), a literal placeholder (`<magic-link-token:alice>`) is the correct stand-in until that seam exists (e.g. a fake email adapter in a later stage) — see `registration.e2e-spec.ts`'s `um-reg-05` note. Same for a precondition no request can ever produce on purpose (e.g. a genuinely *wrong* system-inferred value) — seed the closest real substitute through whatever endpoint is available and say so in a comment, rather than leaving a placeholder nothing ever created.
- **Session/authorization stays out of scope for this suite** if its own docs say so (e.g. the user-management suite's README: "this suite tests workflow and data correctness, not who is entitled" — that's access-control's job). `Bearer <token:Persona>` headers stay literal placeholders even in an otherwise-real test; don't try to make auth real here.
- Reuse the run-scoped fixture pattern from `registration.e2e-spec.ts` (`emailFor(persona)`, `afterAll` cleanup via `prisma.user.deleteMany`) to create whatever real personas a file's own preconditions need.
