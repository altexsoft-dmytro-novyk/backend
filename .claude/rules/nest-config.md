---
paths:
  - "src/config/**"
  - ".env.example"
---

# Environment Configuration Conventions

## Adding a new env variable — three places, always

1. `.env` — the actual local value (gitignored)
2. `.env.example` — the committed template
3. `src/config/env.validation.ts` — the Joi schema entry, with a `.default(...)` when a sane default exists, `.required()` otherwise

A variable missing from the Joi schema is silently stripped from `ConfigService` typing discipline — never skip step 3.

## Access

- Only via `ConfigService` — `config.getOrThrow<string>('KEY')` for required values
- No `process.env` in application code. The single exception: `prisma.config.ts` (runs outside Nest DI, loads env via `dotenv/config`)
