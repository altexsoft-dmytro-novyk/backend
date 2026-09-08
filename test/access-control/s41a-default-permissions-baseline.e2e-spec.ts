import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * PLAT-E4-S4.1a Stage 2 — the `DEFAULT_PERMISSIONS` baseline (SCP
 * sprint-change-proposal-2026-09-04-section-access-consolidation.md D2).
 *
 * Translates only approved S4.1a-DP-01..03 scenario contracts through the
 * real facade/module/Prisma/PostgreSQL path — no repository fakes, no
 * provider overrides, no invented HTTP endpoint.
 *
 * EXPECTED RED: DP-01 fails today — `'profile:identity:write'` is not a
 * seeded permission and the active fixture user holds no policy attachment,
 * so current `isAllowed` resolves `false` where this contract requires
 * `true`. DP-02/03 already pass under today's code (an inactive or missing
 * user is denied for any key already) and are included here as the locked
 * regression contract the new evaluator branch must not break.
 */
describe('PLAT-E4-S4.1a Stage 2 — DEFAULT_PERMISSIONS baseline (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `s41adp-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const baselineKey = 'profile:identity:write';
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (persona: string, isActive = true) => {
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
        createdBy: ids.Owner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  const allow = (userId: string, key: string) => facade.isAllowed(userId, key);

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    }).compile();
    await moduleFixture.init();
    facade = moduleFixture.get(AccessControlFacade);
    prisma = moduleFixture.get(PrismaService);

    // `users.createdBy` is a restrictive self-FK; reuse an already-migrated
    // active user as creator and never delete that non-fixture row.
    const creator = await prisma.user.findFirst({
      where: { isActive: true },
      select: { id: true },
    });
    expect(creator).not.toBeNull();
    ids.Owner = creator!.id;

    await createUser('ActiveNoAttachment');
    await createUser('Inactive', false);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: {
          id: {
            in: Object.values(ids).filter((id) => id !== ids.Owner),
          },
        },
      });
    }
    await moduleFixture?.close();
  });

  // S4.1a-DP-01
  it('allows an active user with zero policy attachments through the DEFAULT_PERMISSIONS baseline', async () => {
    await expect(allow(ids.ActiveNoAttachment, baselineKey)).resolves.toBe(
      true,
    );
  });

  // S4.1a-DP-02
  it('denies a deactivated user the baseline key despite no per-individual carve-out', async () => {
    await expect(allow(ids.Inactive, baselineKey)).resolves.toBe(false);
  });

  // S4.1a-DP-03
  it('denies a nonexistent user id the baseline key as an ordinary false result', async () => {
    await expect(allow(uuidv7(), baselineKey)).resolves.toBe(false);
  });
});
