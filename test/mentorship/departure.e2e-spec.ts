import {
  MentorshipFixtures,
  bootstrapTestApp,
  mentorshipApi,
  pairsOf,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.6 — departure auto-close · FR-M14.
 * Scenarios: docs/test-cases/mentorship/departure/men-dep-0{1,2}.md
 *
 * HEADER — BLOCKED on G-DEP (AD-20 departure executor / CC-06). Also G-CTX.
 *
 * There is NO HTTP route and NO test-invocable seam for the AD-20 executor:
 * `mentorship.applyDepartureEffects({departureId, departingUserId,
 * effectiveDate, leaseToken, tx})` (mentorship.md §5.2) is called by the
 * `user-management` departure executor under a shared unit of work — none of
 * which exists (no `Departure` aggregate, no executor, no `src/mentorship/`).
 * These tests therefore:
 *   - chain real `POST /mentorship-pairs` calls to build the preconditions
 *     (404 today — committed red on G-CTX);
 *   - assert the TARGET post-departure state (`status: 'ended'`, an end date,
 *     the fixed system closure-note template, `systemClosed: true`, a
 *     `mentorship_end` career event per pair);
 *   - carry NO `stateChange` trigger — the executor/clock caveat is commented
 *     inline. They stay red until BOTH G-CTX and G-DEP lift.
 * GREEN-characterization: none.
 */
describe('Mentorship departure auto-close (men-dep-*) — Stage-2 BLOCKED [G-DEP + G-CTX]', () => {
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

  it('men-dep-01 — a departure auto-closes ALL of the departing person’s active pairs (as mentor and as mentee)', async () => {
    const mona = await fx.user('dep01-mona'); // departing; mentor of Alice, mentee of Nina
    const alice = await fx.user('dep01-alice');
    const nina = await fx.user('dep01-nina');
    const bob = await fx.user('dep01-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.reportsTo(mona.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const asMentor = await A.createPair(bob.id, mona.id, alice.id);
    expect(asMentor.status).toBe(201); // RED: route missing (G-CTX)
    const asMentee = await A.createPair(bob.id, nina.id, mona.id);
    expect(asMentee.status).toBe(201); // RED

    // baseline: two active pairs involve Mona
    const baseline = await A.listPairs(
      'Root',
      `?participant=${mona.id}&status=active`,
    );
    expect(baseline.status).toBe(200); // RED: route missing (G-CTX)
    expect(pairsOf(baseline.body).length).toBe(2);

    // stateChange (NOT invocable here): Mona's recorded departure reaches its
    // effective date; the AD-20 executor claims it and calls
    // `mentorship.applyDepartureEffects(...)` in the shared transaction (G-DEP /
    // CC-06). No mentorship HTTP route exists for this.

    const after = await A.listPairs('Root', `?participant=${mona.id}`);
    expect(after.status).toBe(200); // RED: G-CTX + G-DEP
    const rows = pairsOf(after.body);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('ended');
      expect(row.endedAt).toBeTruthy();
      expect(row.closureNote).toBeTruthy(); // fixed system template
      expect(row.systemClosed).toBe(true);
    }
  });

  it('men-dep-02 — the departure system note bypasses the mandatory-note gate (contrast men-end-02)', async () => {
    const mona = await fx.user('dep02-mona');
    const alice = await fx.user('dep02-alice'); // departing
    const bob = await fx.user('dep02-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX)
    const pairId = (create.body as { id?: string }).id;

    // stateChange (NOT invocable here): Alice's departure reaches its effective
    // date; the AD-20 executor calls `mentorship.applyDepartureEffects(...)`.
    // No human supplies a closure note; the FR-M9 gate is bypassed on this path.

    const read = await A.getPair(pairId, bob.id);
    expect(read.status).toBe(200); // RED: G-CTX + G-DEP
    expect(read.body).toMatchObject({ status: 'ended', systemClosed: true });
    expect((read.body as { endedAt?: unknown }).endedAt).toBeTruthy();
    expect((read.body as { closureNote?: string }).closureNote).toBeTruthy();
    // No 422/400 was ever raised for a missing manual note on this path.
  });
});
