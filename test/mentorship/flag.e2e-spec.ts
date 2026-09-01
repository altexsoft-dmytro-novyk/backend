import {
  MentorshipFixtures,
  bootstrapTestApp,
  mentorshipApi,
  mentorshipStatusValue,
  isMentorStatus,
  pairsOf,
  s13Summary,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.1 — open-to-mentoring flag · FR-M1, FR-M3.
 * Scenarios: docs/test-cases/mentorship/flag/men-flag-0{1..4}.md
 *
 * HEADER — why every test here is committed RED:
 *   - ROUTE MISSING (G-CTX): `GET/PATCH /users/:id/mentorship-availability`
 *     does not exist (mentorship.md §3/§4). Nest returns 404 before any guard.
 *   - MODEL MISSING (G-CTX): no `MentorshipAvailability` table/aggregate.
 *   - `GET /users/:id` DOES exist and 200s, but carries no S13 inline summary
 *     key (G-CTX + G-S13) — assertions on the flag / status there are red on a
 *     missing key (a clean assertion failure, not a crash).
 *   - men-flag-03 also needs `POST /mentorship-pairs` (G-CTX) + `mentorship:assign`
 *     (G-PERM).
 *   - men-flag-04 is a Self-only identity-equality rule (mentorship.md §4) — it
 *     needs NO facade call, so it is NOT G-S13-blocked; it is 404 today, 403
 *     once the controller lands.
 * GREEN-characterization: none.
 */
describe('Mentorship flag (men-flag-*) — Stage-2 committed red [G-CTX; men-flag-03 +G-PERM; men-flag-04 Self-only]', () => {
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

  it('men-flag-01 — Self sets own open-to-mentoring flag; appears in the pool', async () => {
    const mona = await fx.user('flag01-mona');
    const bob = await fx.user('flag01-bob');
    await fx.grantMentorshipAssign(bob.id);

    const set = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(set.status).toBe(200); // RED: route missing (G-CTX)
    expect(set.body).toMatchObject({ openToMentoring: true });

    const pool = await A.pool(bob.id);
    expect(pool.status).toBe(200); // RED: route missing (G-CTX)
    const ids = pairsOf(pool.body).map((row) => (row as { id?: string }).id);
    expect(ids).toContain(mona.id);
  });

  it('men-flag-02 — Self clears own flag; leaves the pool', async () => {
    const mona = await fx.user('flag02-mona');
    const bob = await fx.user('flag02-bob');
    await fx.grantMentorshipAssign(bob.id);

    const on = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(on.status).toBe(200); // RED: route missing (G-CTX)

    const off = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: false,
    });
    expect(off.status).toBe(200); // RED: route missing (G-CTX)
    expect(off.body).toMatchObject({ openToMentoring: false });

    const pool = await A.pool(bob.id);
    expect(pool.status).toBe(200);
    const ids = pairsOf(pool.body).map((row) => (row as { id?: string }).id);
    expect(ids).not.toContain(mona.id);
  });

  it('men-flag-03 — clear the flag while holding an active mentee: flag clears, pair untouched, status stays `mentor`', async () => {
    const mona = await fx.user('flag03-mona');
    const alice = await fx.user('flag03-alice');
    const bob = await fx.user('flag03-bob');
    await fx.reportsTo(alice.id, bob.id); // Bob has reporting access over Alice
    await fx.grantMentorshipAssign(bob.id);

    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX) / G-PERM
    const pairId = (create.body as { id?: string }).id;
    const startedAt = (create.body as { startedAt?: string }).startedAt;

    const clear = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: false,
    });
    expect(clear.status).toBe(200);
    expect(clear.body).toMatchObject({ openToMentoring: false });

    // The active pair is untouched (AD-17: clearing the flag never mutates a pair).
    const pair = await A.getPair(pairId, mona.id);
    expect(pair.status).toBe(200);
    expect(pair.body).toMatchObject({ status: 'active' });
    expect((pair.body as { endedAt?: unknown }).endedAt ?? null).toBeNull();
    expect((pair.body as { startedAt?: string }).startedAt).toBe(startedAt);

    // Status stays `mentor` while the pair is active; flag reads false.
    const profile = await A.getProfile(mona.id, mona.id);
    expect(profile.status).toBe(200);
    expect(isMentorStatus(mentorshipStatusValue(profile.body))).toBe(true); // RED: no S13 summary key
    expect(s13Summary(profile.body)?.openToMentoring).toBe(false);

    // Removed from the pool for future assignments.
    const pool = await A.pool(bob.id);
    expect(pool.status).toBe(200);
    const ids = pairsOf(pool.body).map((row) => (row as { id?: string }).id);
    expect(ids).not.toContain(mona.id);
  });

  it('men-flag-04 — a non-Self actor cannot set someone else’s flag (Self-only identity equality, not a permission)', async () => {
    const alice = await fx.user('flag04-alice');
    const bob = await fx.user('flag04-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id); // holding the permission must NOT help

    const attempt = await A.patchAvailability(alice.id, bob.id, {
      openToMentoring: true,
    });
    // 404 today (route missing); 403 once the Self-only controller lands.
    expect(attempt.status).toBe(403);

    const profile = await A.getProfile(alice.id, alice.id);
    expect(profile.status).toBe(200);
    expect(s13Summary(profile.body)?.openToMentoring ?? false).toBe(false); // RED: no S13 summary key
  });
});
