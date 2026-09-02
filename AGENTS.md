<!-- bmad:context -->
<!-- Verified 2026-09-02 against 08931ad. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## backend (NestJS API)

NestJS 11 API for people management. PostgreSQL via Prisma 7. Path-scoped conventions in `.claude/rules/`; stack and structure in `CLAUDE.md`. Binding architecture decisions live in the workspace spine, not in this repo.

## Policy

- Commit API changes here, not in the workspace root.
- Never add new features under `src/modules/` — use a bounded context at `src/<context-name>/` with hexagonal layout (`application/`, `domain/`, `infrastructure/`).
- Never edit applied files under `prisma/migrations/` or hand-edit `src/generated/`.

## Where things are

- Before implementing or changing backend behavior, read `../../docs/architecture/README.md` and the relevant linked binding documents, including DDD, API conventions, testing strategy, and Access Control.
- Bounded contexts: `src/access-control/`, `src/user-management/`, `src/storage/`; legacy stub: `src/modules/health`
- Implementing or changing bounded-context wiring? Read AD-2 in workspace `_bmad-output/planning-artifacts/architecture/architecture-people-management-2026-08-19/ARCHITECTURE-SPINE.md`
- Domain specs for active work: workspace `_bmad-output/specs/spec-*/SPEC.md`

## Running and verifying

- Run `nvm use` before any npm command — Node >=24 (`.nvmrc`).
- E2e and measurement tests need Postgres running (`npm run db:up`); unit tests do not.

## Conventions that differ from defaults

- Controllers get `/api/v1/...` from `main.ts` — never hardcode that prefix.
- E2e tests use unprefixed routes (`/users`, not `/api/v1/users`) and must re-apply `ValidationPipe` manually — see `.claude/rules/nest-e2e.md`.
- Import supertest as default: `import request from 'supertest'`.
- Prisma datasource URL lives in `prisma.config.ts`, not `schema.prisma`.

## Known pitfalls

- E2e preconditions must be created via real API calls in the same file — never hardcoded placeholder IDs.
- `application/actions/` must not `@Inject` port tokens; only domain services hold ports (workspace spine AD-2).

<!-- /bmad:context -->
