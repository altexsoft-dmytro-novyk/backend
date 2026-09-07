import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import {
  AccessControlFacade,
  type SectionAccess,
} from '../../src/access-control/application/access-control.facade';
import {
  FULL_PROFILE_ACCESS_PORT,
  type FullProfileAccessPort,
} from '../../src/access-control/domain/interfaces/full-profile-access.port';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// PLAT-E4-S4.2c — full-profile-access overlay · AD-1 Stage 2, component-level
// suite (synthetic SECTION_ACCESS_MATRIX row cases).
//
// Scenarios: docs/test-cases/access-control-kernel/full-profile-overlay/
//   acm11-fpo-03-holder-bumps-a-none-cell-to-read.md
//   acm11-fpo-04-overlay-never-upgrades-to-write.md
//   acm11-fpo-05-overlay-does-not-apply-to-inactive-or-unknown-target.md
//     — Test 3 ONLY (the synthetic-row target cases). Test 1/Test 2 (the
//     real `profile:identity` target cases) live in the sibling file
//     `acm11-full-profile-overlay-real-sections.e2e-spec.ts`, together with
//     ACM11-FPO-06. Judgment call, reported at dispatch time: ACM11-FPO-06's
//     own Preconditions state, verbatim, "the real, unmocked
//     SECTION_ACCESS_MATRIX (no jest.mock in this file)" — a `jest.mock`
//     call is file-global in Jest, so a single file cannot host one describe
//     block with the matrix mocked (this file's own FPO-03/04, and FPO-05's
//     synthetic-row Test 3) and a sibling describe block with the matrix
//     genuinely unmocked (FPO-06, and FPO-05's real-section Test 1/2)
//     without breaking FPO-06's own explicit precondition. Splitting by
//     "does this file call jest.mock at all" — rather than forcing every
//     fpo-03..06 scenario into the one file the spec's Tasks & Acceptance
//     bullet names — is the split that keeps every doc's own literal
//     Preconditions true. This file's own two Stage-1 docs (03, 04) each ask
//     for the matrix to export "exactly one synthetic row ... instead of the
//     real three-row matrix"; the mock below technically layers the
//     synthetic row ON TOP of the real three (via `jest.requireActual`)
//     rather than replacing them outright, but neither FPO-03 nor FPO-04
//     ever addresses a real section key, so the two are behaviourally
//     identical for what these tests actually exercise. The spread also lets
//     FPO-05's synthetic-row Test 3 share this file's one `jest.mock` call.
//
// HARNESS SHAPE (AF-6 ruling: unit/component-level proof only): a real
// AccessControlFacade / AudienceResolverService / FunctionalRoleEvaluatorService
// (via the real AccessControlModule + AppModule, real Postgres-backed
// identity/relationship ports), PLUS a real FullProfileOverlayService backed
// by a FullProfileAccessPort TEST DOUBLE (`isActiveHolder(rootId) → true`,
// else `false`) — a double, not a seeded real `full_profile_grants` row, per
// each doc's own Given (and because no Stage-2 migration exists yet to seed
// a real row against).
//
// EXPECTED RED at HEAD de508c9: BOTH new-module imports above
// (`full-profile-access.port`, `full-profile-overlay.service`) do not exist
// yet — this file cannot even compile/load, a stronger red than a runtime
// assertion failure.

jest.mock(
  '../../src/access-control/domain/constants/section-access-matrix',
  () => {
    const actual: typeof import('../../src/access-control/domain/constants/section-access-matrix') =
      jest.requireActual(
        '../../src/access-control/domain/constants/section-access-matrix',
      );
    return {
      ...actual,
      SECTION_ACCESS_MATRIX: {
        ...actual.SECTION_ACCESS_MATRIX,
        'fpo:synthetic-none-cell': {
          self: 'write',
          reporting: 'write',
          pp: 'write',
          colleague: 'none',
        },
      },
    };
  },
);

describe('ACM11-FPO-03..05 · component-level overlay resolution (synthetic SECTION_ACCESS_MATRIX row)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm11-fpo-res-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (
    persona: string,
    isActive = true,
  ): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        firstName: persona,
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor(persona),
        companyJoinDate: new Date('2020-01-01'),
        isActive,
        createdBy: ids.FixtureOwner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  beforeAll(async () => {
    // Test-double FullProfileAccessPort: Root is the only holder, exactly as
    // each doc's own Given specifies (`isActiveHolder(rootId) → true`;
    // `isActiveHolder(anyOtherId) → false`). Reads `ids.Root` lazily inside
    // the async closure — safe, because it is only ever invoked (by the
    // facade, once wired) after `createUser('Root')` below has populated it.
    const holderDouble: FullProfileAccessPort = {
      isActiveHolder: (userId: string) => Promise.resolve(userId === ids.Root),
    };

    // CORRECTED 2026-09-07 (John, PM) — a provider declared in the outer
    // testing module's own `providers` array does not reach a dependency
    // that `AccessControlFacade` resolves from inside `AccessControlModule`'s
    // own scope; NestJS module encapsulation keeps the two separate unless
    // the binding is replaced with `.overrideProvider(...).useValue(...)`,
    // which patches the token inside every module that provides it. The real
    // `FullProfileOverlayService`/adapter binding registered by
    // `AccessControlModule` is what the facade actually receives without
    // this override — confirmed by reproducing the exact "Expected read,
    // Received none" failure this caused before the fix.
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    })
      .overrideProvider(FULL_PROFILE_ACCESS_PORT)
      .useValue(holderDouble)
      .compile();
    await moduleFixture.init();
    facade = moduleFixture.get(AccessControlFacade);
    prisma = moduleFixture.get(PrismaService);

    const fixtureOwnerId = uuidv7();
    await prisma.user.create({
      data: {
        id: fixtureOwnerId,
        firstName: 'Fixture',
        lastName: 'Owner',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor('fixture-owner'),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: fixtureOwnerId,
      },
      select: { id: true },
    });
    ids.FixtureOwner = fixtureOwnerId;

    await createUser('Root');
    await createUser('Nadia');
    await createUser('Priya');
    await createUser('Dana', false); // deactivated target, ACM11-FPO-05
  });

  afterAll(async () => {
    if (prisma) {
      const fixtureIds = Object.values(ids);
      await prisma.user.deleteMany({ where: { id: { in: fixtureIds } } });
    }
    if (moduleFixture) {
      await moduleFixture.close();
    }
  });

  describe('ACM11-FPO-03 · a holder bumps a synthetic "none" cell to "read"; a non-holder does not', () => {
    it('Test 1 — a holder’s "none"-cell resolution is bumped to "read"', async () => {
      const result: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'fpo:synthetic-none-cell',
        ids.Priya,
      );
      expect(result).toBe('read');
    });

    it('Test 2 — a non-holder’s "none"-cell resolution is unchanged', async () => {
      const result: SectionAccess = await facade.canAccessSection(
        ids.Nadia,
        'fpo:synthetic-none-cell',
        ids.Priya,
      );
      expect(result).toBe('none');
    });
  });

  describe('ACM11-FPO-04 · the overlay’s own contribution is capped at "read", never "write"', () => {
    it('Test — a holder with no write-granting relation to the target never receives write', async () => {
      const result: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'fpo:synthetic-none-cell',
        ids.Priya,
      );
      expect(result).toBe('read');
      expect(result).not.toBe('write');
    });
  });

  describe('ACM11-FPO-05 (synthetic-row half) · overlay does not apply to an inactive/unknown target', () => {
    it('Test 3 — a holder resolving a deactivated or nonexistent target against the synthetic row still gets none', async () => {
      const deactivated: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'fpo:synthetic-none-cell',
        ids.Dana,
      );
      expect(deactivated).toBe('none');

      const nonexistentId = uuidv7();
      const nonexistent: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'fpo:synthetic-none-cell',
        nonexistentId,
      );
      expect(nonexistent).toBe('none');
    });
  });
});
