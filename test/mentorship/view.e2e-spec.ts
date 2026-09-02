import {
  MentorshipFixtures,
  bootstrapTestApp,
  mentorshipApi,
  pairsOf,
  s13Summary,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.5 — S13 projection, profile-header mentor, directory
 * filter · FR-M2, FR-M8, FR-M15, FR-M16, FR-M17.
 * Scenarios: docs/test-cases/mentorship/view/men-view-0{1..5}.md
 *
 * HEADER — why every test here is committed RED:
 *   - ROUTE MISSING (G-CTX): `GET /mentorship-pairs[/:id]` do not exist.
 *   - MODEL MISSING (G-CTX): no `MentorshipPair` / `MentorshipAvailability`.
 *   - `GET /users/:id` DOES exist and 200s, but the S1 card carries no `mentor`
 *     field (men-view-03) and no inline S13 summary key (men-view-01/04) — red
 *     on missing keys (clean assertion failures).
 *   - G-S13 (men-view-01/04): the inline S13 audience narrowing needs the S13
 *     base decision; `canAccessSection('S13')` does not exist (ACM-5).
 *   - men-view-05: `GET /users` exists, but `?mentorshipStatus=` is not a
 *     `ListUsersQueryDto` field, so `ValidationPipe({whitelist:true})` strips it
 *     silently and the list returns unfiltered — red because the excluded
 *     personas are still present. The directory engine is platform scope; this
 *     only asserts mentorship supplies a correct, non-leaking status value.
 *   - Preconditions chained through real `POST /mentorship-pairs` (404 today).
 * GREEN-characterization: none.
 */
describe('Mentorship views (men-view-*) — Stage-2 committed red [G-CTX (+G-S13 view-01/04); view-05 directory scope]', () => {
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

  it('men-view-01 — Self sees own mentor and (empty) mentee list plus own flag', async () => {
    const mona = await fx.user('view01-mona');
    const alice = await fx.user('view01-alice');
    const bob = await fx.user('view01-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX)

    const profile = await A.getProfile(alice.id, alice.id);
    expect(profile.status).toBe(200);
    const summary = s13Summary(profile.body);
    expect(summary).not.toBeNull(); // RED: no S13 inline summary key (G-CTX + G-S13)
    expect(summary?.mentor?.userId).toBe(mona.id);
    expect(summary?.mentees ?? []).toEqual([]);
    expect(typeof summary?.openToMentoring).toBe('boolean');
    for (const pair of summary?.pairs ?? []) {
      expect(pair).not.toHaveProperty('closureNote');
    }
  });

  it('men-view-02 — the all-pairs view lists active and ended pairs with dates and status', async () => {
    const mona = await fx.user('view02-mona');
    const alice = await fx.user('view02-alice');
    const nina = await fx.user('view02-nina');
    const colin = await fx.user('view02-colin');
    const bob = await fx.user('view02-bob');
    const paula = await fx.user('view02-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.reportsTo(colin.id, bob.id);
    await fx.peoplePartnerOf(colin.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const active = await A.createPair(bob.id, mona.id, alice.id);
    expect(active.status).toBe(201); // RED: route missing (G-CTX)

    const toEnd = await A.createPair(bob.id, nina.id, colin.id);
    expect(toEnd.status).toBe(201); // RED
    const end = await A.endPair((toEnd.body as { id?: string }).id, paula.id, {
      closureNote: 'Rotation finished.',
    });
    expect(end.status).toBe(200); // RED

    const all = await A.listPairs(bob.id);
    expect(all.status).toBe(200);
    const rows = pairsOf(all.body);
    const activeRow = rows.find(
      (p) => p.mentorUserId === mona.id && p.menteeUserId === alice.id,
    );
    const endedRow = rows.find(
      (p) => p.mentorUserId === nina.id && p.menteeUserId === colin.id,
    );
    expect(activeRow).toMatchObject({ status: 'active' });
    expect(activeRow?.endedAt ?? null).toBeNull();
    expect(endedRow).toMatchObject({ status: 'ended' });
    expect(endedRow?.endedAt).toBeTruthy();
    expect(endedRow?.startedAt).toBeTruthy();

    const onlyActive = await A.listPairs(bob.id, '?status=active');
    expect(onlyActive.status).toBe(200);
    expect(pairsOf(onlyActive.body).every((p) => p.status === 'active')).toBe(
      true,
    );
  });

  it('men-view-03 — the profile header shows the mentor (S1 `mentor` field)', async () => {
    const mona = await fx.user('view03-mona');
    const alice = await fx.user('view03-alice');
    const bob = await fx.user('view03-bob');
    await fx.reportsTo(alice.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const create = await A.createPair(bob.id, mona.id, alice.id);
    expect(create.status).toBe(201); // RED: route missing (G-CTX)

    const profile = await A.getProfile(alice.id, bob.id);
    expect(profile.status).toBe(200);
    // S1 card gains a `mentor` field alongside `manager` / `peoplePartner`.
    // Today the interim S1 card has no `mentor` key -> RED on the missing key.
    const mentor = (profile.body as { mentor?: unknown }).mentor as
      { userId?: string } | string | undefined;
    expect(mentor).toBeDefined();
    const mentorId = typeof mentor === 'string' ? mentor : mentor?.userId;
    expect(mentorId).toBe(mona.id);
  });

  it('men-view-04 — S13 inline summary on the profile: PP sees the closure note, Self does not [G-S13]', async () => {
    const mona = await fx.user('view04-mona'); // Alice's mentor
    const alice = await fx.user('view04-alice');
    const nina = await fx.user('view04-nina'); // Alice's active mentee
    const colin = await fx.user('view04-colin'); // Alice's ended mentee
    const bob = await fx.user('view04-bob');
    const paula = await fx.user('view04-paula'); // Alice's PP
    await fx.reportsTo(alice.id, bob.id);
    await fx.reportsTo(nina.id, alice.id);
    await fx.reportsTo(colin.id, alice.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(alice.id);
    await fx.grantMentorshipAssign(paula.id);

    const asMentee = await A.createPair(bob.id, mona.id, alice.id);
    expect(asMentee.status).toBe(201); // RED: route missing (G-CTX)
    const asMentorActive = await A.createPair(alice.id, alice.id, nina.id);
    expect(asMentorActive.status).toBe(201); // RED
    const asMentorEnded = await A.createPair(alice.id, alice.id, colin.id);
    expect(asMentorEnded.status).toBe(201); // RED
    const end = await A.endPair(
      (asMentorEnded.body as { id?: string }).id,
      paula.id,
      { closureNote: 'Closed with a note only PP/reporting/project can read.' },
    );
    expect(end.status).toBe(200); // RED

    const ppView = await A.getProfile(alice.id, paula.id);
    expect(ppView.status).toBe(200);
    const ppSummary = s13Summary(ppView.body);
    expect(ppSummary).not.toBeNull(); // RED: no S13 inline summary key
    expect(ppSummary?.mentor?.userId).toBe(mona.id);
    expect((ppSummary?.mentees ?? []).map((m) => m.userId)).toContain(nina.id);
    const endedForPp = (ppSummary?.pairs ?? []).find(
      (p) => p.menteeUserId === colin.id,
    );
    expect(endedForPp?.closureNote).toBeTruthy();

    const selfView = await A.getProfile(alice.id, alice.id);
    expect(selfView.status).toBe(200);
    const selfSummary = s13Summary(selfView.body);
    expect(selfSummary).not.toBeNull(); // RED
    for (const pair of selfSummary?.pairs ?? []) {
      expect(pair).not.toHaveProperty('closureNote'); // absent for Self
    }
  });

  it('men-view-05 — mentorship status is a filterable directory field (non-leaking) [directory scope]', async () => {
    const shared = `Dir-${fx.runId.slice(-8)}`;
    const mona = await fx.user('view05-mona', { lastName: shared }); // -> mentor
    const nina = await fx.user('view05-nina', { lastName: shared }); // -> open to mentoring
    const colin = await fx.user('view05-colin', { lastName: shared }); // -> neither
    const bob = await fx.user('view05-bob');
    const aliceMentee = await fx.user('view05-alice', { lastName: shared });
    await fx.reportsTo(aliceMentee.id, bob.id);
    await fx.grantMentorshipAssign(bob.id);

    const pair = await A.createPair(bob.id, mona.id, aliceMentee.id);
    expect(pair.status).toBe(201); // RED: route missing (G-CTX) -> Mona never actually becomes `mentor`
    const ninaFlag = await A.patchAvailability(nina.id, nina.id, {
      openToMentoring: true,
    });
    expect(ninaFlag.status).toBe(200); // RED: route missing (G-CTX)

    // `Bearer <token:Root>` — the seeded HR Admin holds `user-management:list`
    // (the directory read gate); Bob does not.
    const mentors = await A.listUsers(
      'Root',
      `?lastName=${shared}&mentorshipStatus=mentor&pageSize=100`,
    );
    expect(mentors.status).toBe(200);
    const mentorIds = pairsOf(mentors.body).map(
      (u) => (u as { id?: string }).id,
    );
    expect(mentorIds).toContain(mona.id);
    expect(mentorIds).not.toContain(nina.id); // RED: filter param is stripped, Nina still present
    expect(mentorIds).not.toContain(colin.id); // RED

    const open = await A.listUsers(
      'Root',
      `?lastName=${shared}&mentorshipStatus=open-to-mentoring&pageSize=100`,
    );
    expect(open.status).toBe(200);
    const openIds = pairsOf(open.body).map((u) => (u as { id?: string }).id);
    expect(openIds).toContain(nina.id);
    expect(openIds).not.toContain(mona.id); // RED
    expect(openIds).not.toContain(colin.id); // RED
  });
});
