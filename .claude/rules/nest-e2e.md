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
