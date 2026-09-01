import {
  MentorshipFixtures,
  UNRELATED_PERMISSION,
  bootstrapTestApp,
  mentorshipApi,
  mentorshipStatusValue,
  isMentorStatus,
  isOpenToMentoringStatus,
  pairsOf,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.3 — create a mentorship pair · FR-M5, FR-M6, FR-M7.
 * Scenarios: docs/test-cases/mentorship/pair/men-pair-0{1..5}.md
 *
 * HEADER — why every test here is committed RED:
 *   - ROUTE MISSING (G-CTX): `POST /mentorship-pairs` / `GET /mentorship-pairs`
 *     do not exist (mentorship.md §3). Nest 404s before any guard.
 *   - MODEL MISSING (G-CTX): no `MentorshipPair` table/aggregate.
 *   - G-PERM: create is a §2.2 dual gate — `isAllowed(actor,'mentorship:assign')`
 *     (unseeded) AND mentee within the actor's `resolveAudiences` scope.
 *   - men-pair-04: G-CT — `mentorship_start` needs `user-management` Epic 3
 *     Story 3.1's career-event application boundary AND `GET /users/:id/events`
 *     (also route-missing today).
 *   - Body keys are `{mentorUserId, menteeUserId}` (mentorship.md §3) — the
 *     scenario drafts' `{mentorId, menteeId}` are superseded.
 * GREEN-characterization: none.
 */
describe('Mentorship pair create (men-pair-*) — Stage-2 committed red [G-CTX + G-PERM; men-pair-04 +G-CT]', () => {
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

  it('men-pair-01 — create a pair with a mentee in the assigner’s access scope', async () => {
    const mona = await fx.user('pair01-mona');
    const alice = await fx.user('pair01-alice');
    const bob = await fx.user('pair01-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);
    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX) / G-PERM
    expect(create.body).toMatchObject({
      mentorUserId: mona.id,
      menteeUserId: alice.id,
      status: 'active',
    });
    expect((create.body as { startedAt?: unknown }).startedAt).toBeTruthy();
    expect((create.body as { endedAt?: unknown }).endedAt ?? null).toBeNull();
    expect(create.body).not.toHaveProperty('closureNote');

    const list = await A.listPairs(bob.id);
    expect(list.status).toBe(200);
    const match = pairsOf(list.body).find(
      (p) => p.mentorUserId === mona.id && p.menteeUserId === alice.id,
    );
    expect(match).toMatchObject({ status: 'active' });
  });

  it('men-pair-02 — mentee outside the assigner’s access scope is rejected (resolveAudiences empty) → 403, no pair', async () => {
    const mona = await fx.user('pair02-mona');
    const alice = await fx.user('pair02-alice');
    const bob = await fx.user('pair02-bob');
    const eve = await fx.user('pair02-eve'); // NO edges to Bob -> colleague-only
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const create = await A.createPair(bob.id, mona.id, eve.id);
    // 404 today (route missing); 403 once the mentee-scoping gate lands.
    expect(create.status).toBe(403);

    const list = await A.listPairs(bob.id);
    expect(list.status).toBe(200);
    expect(
      pairsOf(list.body).some((p) => p.menteeUserId === eve.id),
    ).toBe(false);
  });

  it('men-pair-03 — first active pair flips status `open to mentoring` → `mentor`', async () => {
    const mona = await fx.user('pair03-mona');
    const alice = await fx.user('pair03-alice');
    const bob = await fx.user('pair03-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);
    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)

    const before = await A.getProfile(mona.id, mona.id);
    expect(before.status).toBe(200);
    expect(isOpenToMentoringStatus(mentorshipStatusValue(before.body))).toBe(
      true,
    ); // RED: no S13 summary key

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX)

    const after = await A.getProfile(mona.id, mona.id);
    expect(after.status).toBe(200);
    expect(isMentorStatus(mentorshipStatusValue(after.body))).toBe(true); // RED
  });

  it('men-pair-04 — pair creation writes `mentorship_start` to the career timeline (same transaction) [G-CT]', async () => {
    const mona = await fx.user('pair04-mona');
    const alice = await fx.user('pair04-alice');
    const bob = await fx.user('pair04-bob');
    const paula = await fx.user('pair04-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);

    const baseline = await A.getEvents(alice.id, paula.id);
    expect(baseline.status).toBe(200); // RED: `GET /users/:id/events` route missing
    expect(
      pairsOf(baseline.body).some(
        (e) => (e as { type?: string }).type === 'mentorship_start',
      ),
    ).toBe(false);

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX)

    const events = await A.getEvents(alice.id, paula.id);
    expect(events.status).toBe(200);
    const startEvent = pairsOf(events.body).find(
      (e) => (e as { type?: string }).type === 'mentorship_start',
    ) as { type?: string; source?: string } | undefined;
    expect(startEvent).toBeDefined();
    expect(startEvent?.source).toBe('system'); // RED: G-CT (no career-event boundary)
  });

  it('men-pair-05 — create denied without `mentorship:assign` → 403 (no-target isAllowed; Ida probe)', async () => {
    const mona = await fx.user('pair05-mona');
    const alice = await fx.user('pair05-alice');
    const ida = await fx.user('pair05-ida');
    await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);

    const create = await A.createPair(ida.id, mona.id, alice.id);
    // 404 today (route missing); 403 once the route + G-PERM gate land.
    expect(create.status).toBe(403);
  });
});
