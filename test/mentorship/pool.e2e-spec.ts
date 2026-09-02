import {
  MentorshipFixtures,
  UNRELATED_PERMISSION,
  bootstrapTestApp,
  mentorshipApi,
  pairsOf,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.2 — the willing-mentor pool · FR-M4.
 * Scenarios: docs/test-cases/mentorship/pool/men-pool-0{1..3}.md
 *
 * HEADER — why every test here is committed RED:
 *   - ROUTE MISSING (G-CTX): `GET /mentorship-pool` does not exist
 *     (mentorship.md §3 — supersedes the scenario draft's `GET /willing-mentors`).
 *     Nest 404s before any guard, so the permission gate cannot even run yet.
 *   - MODEL MISSING (G-CTX): no `MentorshipAvailability` / `MentorshipPair`.
 *   - G-PERM: the pool is gated by `isAllowed(viewer, 'mentorship:assign')`
 *     (mentorship.md §5.3); that key is unseeded. The fixtures seed a real
 *     FR-policy chain for it so the assertion is meaningful once both land.
 *   - men-pool-02 needs `POST /mentorship-pairs` (G-CTX) to give Mona pairs.
 * GREEN-characterization: none.
 */
describe('Mentorship pool (men-pool-*) — Stage-2 committed red [G-CTX + G-PERM]', () => {
  let testApp: TestApp;
  let fx: MentorshipFixtures;
  let A: ReturnType<typeof mentorshipApi>;

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
    A = mentorshipApi(testApp);
  });

  beforeEach(() => {
    fx = new MentorshipFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  it('men-pool-01 — permission-holder reads the company-wide pool: S1 identity + flag, every department', async () => {
    const bob = await fx.user('pool01-bob');
    await fx.grantMentorshipAssign(bob.id);
    const mona = await fx.user('pool01-mona', {
      city: 'Krakow',
      position: 'Senior Engineer',
    });
    const nina = await fx.user('pool01-nina', {
      city: 'Gdansk',
      position: 'Designer',
    });

    for (const mentor of [mona, nina]) {
      const set = await A.patchAvailability(mentor.id, mentor.id, {
        openToMentoring: true,
      });
      expect(set.status).toBe(200); // RED: route missing (G-CTX)
    }

    const pool = await A.pool(bob.id);
    expect(pool.status).toBe(200); // RED: route missing (G-CTX) / G-PERM
    const rows = pairsOf(pool.body) as unknown as Array<
      Record<string, unknown>
    >;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const mentor of [mona, nina]) {
      const row = byId.get(mentor.id);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        id: mentor.id,
        firstName: mentor.firstName,
        position: mentor.position,
        openToMentoring: true,
      });
    }
  });

  it('men-pool-02 — the pool never exposes S13 (no mentees / pairs / closureNote keys on a pool row)', async () => {
    const bob = await fx.user('pool02-bob');
    const alice = await fx.user('pool02-alice');
    await fx.reportsTo(alice.id, bob.id);
    const nina = await fx.user('pool02-nina');
    await fx.reportsTo(nina.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);
    const mona = await fx.user('pool02-mona');

    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)

    const active = await A.createPair(bob.id, mona.id, alice.id);
    expect(active.status).toBe(201); // RED: route missing (G-CTX)

    const toEnd = await A.createPair(bob.id, mona.id, nina.id);
    expect(toEnd.status).toBe(201); // RED
    const endRes = await A.endPair((toEnd.body as { id?: string }).id, bob.id, {
      closureNote: 'Wrapped up the first rotation.',
    });
    expect(endRes.status).toBe(200); // RED

    const pool = await A.pool(bob.id);
    expect(pool.status).toBe(200);
    const row = (
      pairsOf(pool.body) as unknown as Array<Record<string, unknown>>
    ).find((r) => r.id === mona.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ id: mona.id, openToMentoring: true });
    for (const leakKey of [
      'mentees',
      'assignedMentees',
      'pairs',
      'closureNote',
      'mentor',
      's13',
    ]) {
      expect(row).not.toHaveProperty(leakKey);
    }
  });

  it('men-pool-03 — pool read denied without `mentorship:assign` → 403 (no-target isAllowed; Ida probe)', async () => {
    const ida = await fx.user('pool03-ida');
    await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]); // holds a role, just not this one

    const pool = await A.pool(ida.id);
    // 404 today (route missing); 403 once the route + G-PERM gate land.
    expect(pool.status).toBe(403);
    expect(pool.body).not.toHaveProperty('items');
  });
});
