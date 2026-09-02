import {
  MentorshipFixtures,
  bootstrapTestApp,
  mentorshipApi,
  mentorshipStatusValue,
  isMentorStatus,
  isOpenToMentoringStatus,
  pairsOf,
  s13Summary,
  type TestApp,
} from './fixtures';

/**
 * Mentorship · Story 1.4 — end a mentorship pair · FR-M9..FR-M13.
 * Scenarios: docs/test-cases/mentorship/end/men-end-0{1..8}.md
 *
 * HEADER — why every test here is committed RED:
 *   - ROUTE MISSING (G-CTX): `POST /mentorship-pairs/:id/end {closureNote}`
 *     (mentorship.md §3 — supersedes the draft `.../closure {note}`) and the
 *     `POST/GET /mentorship-pairs` it depends on do not exist. Nest 404s.
 *   - MODEL MISSING (G-CTX): no `MentorshipPair`; no DB `CHECK` for the
 *     mandatory closure note.
 *   - G-PERM: the end gate is `isAllowed(actor,'mentorship:assign')` (unseeded)
 *     AND `resolveAudiences(actor,[mentee]) ∩ {reporting,pp}` (mentorship.md §5.3).
 *   - G-S13: the closure-note projection needs the S13 base decision.
 *     `canAccessSection('S13')` does not exist (ACM-5 = S1/S10/S11). The
 *     mentorship-owned narrowing runs on `resolveAudiences ∩ {reporting,project,pp}`.
 *   - PROJECT-LINE (men-end-03 Pete): a SECOND blocker — the AC graph adapter
 *     resolves `reporting`/`pp` only; there is no `project` audience yet.
 *   - G-CT (men-end-07): `mentorship_end` needs the career-event boundary +
 *     `GET /users/:id/events` (route-missing).
 *   - Preconditions are chained through real requests ([[feedback_e2e_precondition_fulfillment]]):
 *     an ended pair is produced by a real `POST /mentorship-pairs` then a real
 *     `POST /mentorship-pairs/:id/end` — never a hardcoded id.
 * GREEN-characterization: none.
 */
describe('Mentorship pair end (men-end-*) — Stage-2 committed red [G-CTX + G-PERM (+G-S13 end-03/04, +G-CT end-07)]', () => {
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

  /** Real create -> assert 201 (RED today). Returns the pair id + start date. */
  async function createActivePair(
    assignerId: string,
    mentorId: string,
    menteeId: string,
  ): Promise<{ pairId: string | undefined; startedAt: string | undefined }> {
    const res = await A.createPair(assignerId, mentorId, menteeId);
    expect(res.status).toBe(201); // RED: `POST /mentorship-pairs` route missing (G-CTX)
    return {
      pairId: (res.body as { id?: string }).id,
      startedAt: (res.body as { startedAt?: string }).startedAt,
    };
  }

  it('men-end-01 — end a pair with a closure note; note stored on the pair record', async () => {
    const mona = await fx.user('end01-mona');
    const alice = await fx.user('end01-alice');
    const bob = await fx.user('end01-bob');
    const paula = await fx.user('end01-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);

    const end = await A.endPair(pairId, paula.id, {
      closureNote:
        'Six-month pairing complete; Alice now leads her own onboarding buddy.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX) / G-PERM
    expect(end.body).toMatchObject({ status: 'ended' });
    expect((end.body as { endedAt?: unknown }).endedAt).toBeTruthy();
    expect((end.body as { closureNote?: string }).closureNote).toContain(
      'Six-month pairing complete',
    );

    const read = await A.getPair(pairId, paula.id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'ended' });
    expect((read.body as { closureNote?: string }).closureNote).toBeTruthy();
  });

  it('men-end-02 — ending without a closure note is rejected; the pair stays active', async () => {
    const mona = await fx.user('end02-mona');
    const alice = await fx.user('end02-alice');
    const bob = await fx.user('end02-bob');
    const paula = await fx.user('end02-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);

    const end = await A.endPair(pairId, paula.id, {});
    // 404 today (route missing); 422/400 once the mandatory-note invariant lands.
    expect([400, 422]).toContain(end.status);

    const read = await A.getPair(pairId, paula.id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'active' });
    expect(read.body).not.toHaveProperty('endedAt');
    expect(read.body).not.toHaveProperty('closureNote');
  });

  it('men-end-03 — closure note visible to reporting line (direct + transitive), project line, and PP', async () => {
    const mona = await fx.user('end03-mona');
    const alice = await fx.user('end03-alice');
    const bob = await fx.user('end03-bob'); // direct manager (reporting)
    const carol = await fx.user('end03-carol'); // Bob's manager (reporting, transitive)
    const pete = await fx.user('end03-pete'); // project line
    const paula = await fx.user('end03-paula'); // PP
    await fx.reportsTo(alice.id, bob.id);
    await fx.reportsTo(bob.id, carol.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.onProjectTogether(pete.id, alice.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);
    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Pairing concluded successfully.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX)

    for (const [label, viewer] of [
      ['reporting-direct (Bob)', bob],
      ['reporting-transitive (Carol)', carol],
      ['project-line (Pete)', pete], // also blocked: no `project` audience yet
      ['pp (Paula)', paula],
    ] as const) {
      const read = await A.getPair(pairId, viewer.id);
      expect({ label, status: read.status }).toMatchObject({
        label,
        status: 200,
      });
      expect((read.body as { closureNote?: string }).closureNote).toBeTruthy();
    }
  });

  it('men-end-04a — closure note hidden from the mentee (Self): pair visible, closureNote key absent', async () => {
    const mona = await fx.user('end04a-mona');
    const alice = await fx.user('end04a-alice');
    const bob = await fx.user('end04a-bob');
    const paula = await fx.user('end04a-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);
    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Not for the mentee.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX)

    const read = await A.getPair(pairId, alice.id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'ended',
      menteeUserId: alice.id,
    });
    expect(read.body).not.toHaveProperty('closureNote'); // absent, not null
  });

  it('men-end-04b — closure note hidden from the mentor: pair visible, closureNote key absent', async () => {
    const mona = await fx.user('end04b-mona');
    const alice = await fx.user('end04b-alice');
    const bob = await fx.user('end04b-bob');
    const paula = await fx.user('end04b-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);
    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Not for the mentor.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX)

    const read = await A.getPair(pairId, mona.id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'ended', mentorUserId: mona.id });
    expect(read.body).not.toHaveProperty('closureNote'); // absent, not null
  });

  it('men-end-04c — a colleague has no S13 access to the pair at all → 404 leak-free', async () => {
    const mona = await fx.user('end04c-mona');
    const alice = await fx.user('end04c-alice');
    const bob = await fx.user('end04c-bob');
    const paula = await fx.user('end04c-paula');
    const colin = await fx.user('end04c-colin'); // no relation to Alice
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);
    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Confidential.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX)

    const read = await A.getPair(pairId, colin.id);
    expect(read.status).toBe(404); // 404 today too (route missing) — right code, wrong reason until G-CTX+G-S13
    expect(JSON.stringify(read.body)).not.toContain(alice.workEmail);
  });

  it('men-end-05 — status returns to `open to mentoring` when no active mentee remains and the flag is still set', async () => {
    const mona = await fx.user('end05-mona');
    const alice = await fx.user('end05-alice');
    const bob = await fx.user('end05-bob');
    const paula = await fx.user('end05-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);
    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);

    const before = await A.getProfile(mona.id, mona.id);
    expect(before.status).toBe(200);
    expect(isMentorStatus(mentorshipStatusValue(before.body))).toBe(true); // RED

    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Pairing concluded.',
    });
    expect(end.status).toBe(200); // RED

    const after = await A.getProfile(mona.id, mona.id);
    expect(after.status).toBe(200);
    expect(isOpenToMentoringStatus(mentorshipStatusValue(after.body))).toBe(
      true,
    ); // RED
  });

  it('men-end-06 — status does NOT return to the pool when the flag was cleared before the last pair ended', async () => {
    const mona = await fx.user('end06-mona');
    const alice = await fx.user('end06-alice');
    const bob = await fx.user('end06-bob');
    const paula = await fx.user('end06-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const setFlag = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: true,
    });
    expect(setFlag.status).toBe(200); // RED: route missing (G-CTX)
    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);
    const clear = await A.patchAvailability(mona.id, mona.id, {
      openToMentoring: false,
    });
    expect(clear.status).toBe(200); // RED

    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Pairing concluded.',
    });
    expect(end.status).toBe(200); // RED

    const after = await A.getProfile(mona.id, mona.id);
    expect(after.status).toBe(200);
    const status = mentorshipStatusValue(after.body);
    expect(isMentorStatus(status)).toBe(false);
    expect(isOpenToMentoringStatus(status)).toBe(false); // RED: neither
    expect(s13Summary(after.body)?.openToMentoring).toBe(false);

    const bobWithAssign = bob.id;
    const pool = await A.pool(bobWithAssign);
    expect(pool.status).toBe(200);
    expect(
      pairsOf(pool.body).some((r) => (r as { id?: string }).id === mona.id),
    ).toBe(false);
  });

  it('men-end-07 — ending a pair writes `mentorship_end` to the career timeline (same transaction) [G-CT]', async () => {
    const mona = await fx.user('end07-mona');
    const alice = await fx.user('end07-alice');
    const bob = await fx.user('end07-bob');
    const paula = await fx.user('end07-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId } = await createActivePair(bob.id, mona.id, alice.id);

    const baseline = await A.getEvents(alice.id, paula.id);
    expect(baseline.status).toBe(200); // RED: `GET /users/:id/events` route missing
    expect(
      pairsOf(baseline.body).some(
        (e) => (e as { type?: string }).type === 'mentorship_end',
      ),
    ).toBe(false);

    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Pairing concluded.',
    });
    expect(end.status).toBe(200); // RED

    const events = await A.getEvents(alice.id, paula.id);
    expect(events.status).toBe(200);
    const endEvent = pairsOf(events.body).find(
      (e) => (e as { type?: string }).type === 'mentorship_end',
    ) as { type?: string; source?: string } | undefined;
    expect(endEvent).toBeDefined();
    expect(endEvent?.source).toBe('system'); // RED: G-CT
  });

  it('men-end-08 — an ended pair stays in history on both profiles and in the all-pairs view', async () => {
    const mona = await fx.user('end08-mona');
    const alice = await fx.user('end08-alice');
    const bob = await fx.user('end08-bob');
    const paula = await fx.user('end08-paula');
    await fx.reportsTo(alice.id, bob.id);
    await fx.peoplePartnerOf(alice.id, paula.id);
    await fx.grantMentorshipAssign(bob.id);
    await fx.grantMentorshipAssign(paula.id);

    const { pairId, startedAt } = await createActivePair(
      bob.id,
      mona.id,
      alice.id,
    );
    const end = await A.endPair(pairId, paula.id, {
      closureNote: 'Pairing concluded.',
    });
    expect(end.status).toBe(200); // RED: route missing (G-CTX)

    const menteeProfile = await A.getProfile(alice.id, alice.id);
    expect(menteeProfile.status).toBe(200);
    const menteePairs = s13Summary(menteeProfile.body)?.pairs ?? [];
    expect(
      menteePairs.some((p) => p.id === pairId && p.status === 'ended'),
    ).toBe(true); // RED: no S13 summary key

    const mentorProfile = await A.getProfile(mona.id, mona.id);
    expect(mentorProfile.status).toBe(200);
    const mentorPairs = s13Summary(mentorProfile.body)?.pairs ?? [];
    expect(
      mentorPairs.some((p) => p.id === pairId && p.status === 'ended'),
    ).toBe(true); // RED

    const ended = await A.listPairs(paula.id, '?status=ended');
    expect(ended.status).toBe(200);
    const row = pairsOf(ended.body).find((p) => p.id === pairId);
    expect(row).toMatchObject({ status: 'ended', startedAt });
    expect((row as { endedAt?: unknown } | undefined)?.endedAt).toBeTruthy();
  });
});
