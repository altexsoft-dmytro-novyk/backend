---
paths:
  - "src/modules/**"
---

# Feature Module Conventions

Reference example: `src/modules/users/` — copy its patterns for every new module.

## Anatomy

```
src/modules/<name>/
  <name>.module.ts        # controllers + providers only
  <name>.controller.ts    # routing only, no business logic
  <name>.service.ts       # business logic + all DB access
  <name>.swagger.ts       # composite Swagger decorators
  dto/                    # create-<name>.dto.ts, update-<name>.dto.ts
  entities/               # <name>.entity.ts — Swagger response types
  __tests__/              # unit specs (NOT next to source files)
```

Scaffold with `nest g resource modules/<name> --no-spec` (CLI registers the module in `app.module.ts` automatically), then reshape to this anatomy.

## Controller — thin

- Only routing concerns: `@Param('id', ParseUUIDPipe)`, `@HttpCode(HttpStatus.NO_CONTENT)` on delete, delegating to the service
- NO raw `@Api*` decorators on methods — use one composite `@Swagger<Action>()` per method from `<name>.swagger.ts`; `@ApiTags` stays on the class

## Swagger composites (`<name>.swagger.ts`)

```ts
export const SwaggerCreateUser = () =>
  applyDecorators(
    ApiCreatedResponse({ type: UserEntity }),
    ApiConflictResponse({ description: 'Email already taken' }),
  );
```

## Service — owns logic and DB access

- Inject `PrismaService` (global module, no import needed in the feature module)
- Map known Prisma errors to HTTP exceptions in a private `rethrowKnownErrors(error: unknown): never`:
  `P2002` → `ConflictException`, `P2025` → `NotFoundException`; rethrow everything else
- `findOne` checks for `null` and throws `NotFoundException`

## DTO / Entity

- DTO: class-validator decorators + `@ApiProperty`/`@ApiPropertyOptional`; required fields declared with `!`
- Update DTO: `extends PartialType(CreateXDto)` imported from `@nestjs/swagger` (keeps fields visible in docs)
- Entity: `class XEntity implements X` with the model type from `src/generated/prisma/client`, `@ApiProperty` on every field — used as `type:` in Swagger responses

## Unit tests (`__tests__/`)

- Mock dependencies via DI: `{ provide: PrismaService, useValue: { user: { create: jest.fn(), ... } } }`
- Test service happy paths + Prisma error mapping (P2002→409, P2025→404); controller tests just verify delegation
- See `users/__tests__/users.service.spec.ts` for the mock patterns
