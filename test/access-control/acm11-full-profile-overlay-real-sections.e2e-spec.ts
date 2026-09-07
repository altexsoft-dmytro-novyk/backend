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
// suite (real, UNMOCKED SECTION_ACCESS_MATRIX only — no `jest.mock` anywhere
// in this file, deliberately, per ACM11-FPO-06's own Preconditions, verbatim:
// "the real, unmocked SECTION_ACCESS_MATRIX (no jest.mock in this file)").
//
// Scenarios: docs/test-cases/access-control-kernel/full-profile-overlay/
//   acm11-fpo-05-overlay-does-not-apply-to-inactive-or-unknown-target.md
//     — Test 1 / Test 2 ONLY (the real `profile:identity` target cases).
//     Test 3 (the synthetic-row target cases) lives in the sibling file
//     `acm11-full-profile-overlay-resolution.e2e-spec.ts`, which already
//     carries the one `jest.mock`'d matrix this file must not have — see
//     that file's own header comment for the full split rationale.
//   acm11-fpo-06-non-holder-gets-no-overlay-effect-on-real-sections.md
//     ("A pass-already regression lock, not a red-then-green proof" per the
//     doc's own banner)
//
// Both scenarios share one harness shape — real AccessControlFacade, real
// resolver/functionalRoles/fullProfileOverlay, the real unmocked matrix, a
// FullProfileAccessPort test double — which is why they are one file, not
// two.
//
// EXPECTED at HEAD de508c9: the `full-profile-access.port` /
// `full-profile-overlay.service` imports below do not exist yet — this file
// cannot compile/load. Once Stage 3 lands: ACM11-FPO-05's two tests here go
// green as a genuine red→green proof (the CAP-1 early return this depends on
// already exists today at `access-control.facade.ts:81-83`, but
// `isActiveHolder` and the module wiring it needs do not, so the call itself
// cannot even be made yet); ACM11-FPO-06's two tests are, by the doc's own
// framing, a regression LOCK expected to hold trivially once the file
// compiles at all — every cell in all three live `SECTION_ACCESS_MATRIX`
// rows is already `'read'` or `'write'`, so the overlay's `'none' → 'read'`
// bump is structurally a no-op against them (AF-6 finding).

describe('ACM11-FPO-05 (real-section half) & ACM11-FPO-06 · component-level, real unmocked SECTION_ACCESS_MATRIX', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm11-fpo-rs-${uuidv7()}`;
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
    // each doc's own Given specifies.
    const holderDouble: FullProfileAccessPort = {
      isActiveHolder: (userId: string) => Promise.resolve(userId === ids.Root),
    };

    // CORRECTED 2026-09-07 (John, PM, code-review finding) — a provider
    // declared in the outer testing module's own `providers` array does not
    // reach a dependency `AccessControlFacade` resolves from inside
    // `AccessControlModule`'s own scope; without this override Root's
    // holder status never reaches the facade, and this file's assertions
    // passed vacuously against the real `PrismaFullProfileAccessAdapter`
    // (which correctly said "not a holder," since no real grant row exists
    // for a test-created user) rather than against the intended double. Same
    // defect and same fix as `acm11-full-profile-overlay-resolution.e2e-spec.ts`.
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

  describe('ACM11-FPO-05 (real-section half) · a holder resolving a deactivated or nonexistent target still gets none', () => {
    it('Test 1 — a holder resolving a deactivated target gets none', async () => {
      const result: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'profile:identity',
        ids.Dana,
      );
      expect(result).toBe('none');
    });

    it('Test 2 — a holder resolving a nonexistent target gets none', async () => {
      const nonexistentId = uuidv7();
      const result: SectionAccess = await facade.canAccessSection(
        ids.Root,
        'profile:identity',
        nonexistentId,
      );
      expect(result).toBe('none');
    });
  });

  describe('ACM11-FPO-06 · today’s three live sections resolve byte-identically to pre-change behavior', () => {
    const sections = [
      'profile:identity',
      'profile:leave',
      'profile:projects',
    ] as const;

    it('Test 1 — a non-holder’s real-section results are unchanged', async () => {
      for (const section of sections) {
        const result: SectionAccess = await facade.canAccessSection(
          ids.Nadia,
          section,
          ids.Priya,
        );
        expect(result).toBe('read');
      }
    });

    it('Test 2 — a holder’s real-section results are identical to a non-holder’s', async () => {
      for (const section of sections) {
        const result: SectionAccess = await facade.canAccessSection(
          ids.Root,
          section,
          ids.Priya,
        );
        expect(result).toBe('read');
      }
    });
  });
});
