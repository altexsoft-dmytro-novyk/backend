import request from 'supertest';
import {
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
  cleanupUserEvents,
} from './fixtures';

/**
 * Epic 3 — Story 3.1 (System Auto-Generates Career Timeline Events) · AD-1
 * Stage 2, committed red.
 *
 * Scenario (one E2E per row of the matrix, id in the test title):
 *   docs/test-cases/user-management/career-timeline/um-ct-11-timeline-read-audience.md
 *
 * `GET /users/:id/events` is gated by the §3.2 row S9 "Career timeline" READ
 * audience: Self `R`; Reporting line / Project line / PP `RW`; Colleague `—`.
 * §3.3.1: a `—` cell must not leak through any surface.
 *
 * Interim gate (v1.5): `AccessControlFacade.canAccessSection` answers the three
 * legacy section strings only, so Story 3.1 gates this route the mentorship way —
 * `resolveAudiences(viewer, [target]) ∩ { self, reporting, pp } ≠ ∅` → allowed.
 * Project-line is fail-closed system-wide (the resolver does not emit it yet) and
 * starts matching with no change here once Access Control ships it. The
 * assertions below hold identically under the interim rule and the real section
 * call.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *
 *  ALL RED — red-because-route-missing. `users.controller.ts` binds `:id`
 *  GET/PATCH/PUT-photo/DELETE and a collection-root GET/POST/import only — there
 *  is no `/events` sub-route — so every request 404s. Expected once Story 3.1
 *  adds the route + the interim `profile:timeline` gate:
 *    - Self / Reporting line / Assigned PP → 200 with Alice's timeline
 *    - Colleague (Eve, no edge) → 403 (NOT 404, NOT 200-with-[])
 *    - no Authorization header → 401 (the session guard may already produce this;
 *      today the missing route 404s first, which is still red)
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` rows and issue
 * `Bearer <token:<seeded-uuid>>`. DEC-UM-010: one worker, run-namespaced data,
 * wrapped scoped teardown (events -> relationships -> users).
 */
describe('UM-CT-11 · GET /users/:id/events read-audience matrix (e2e, committed red)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  // The four personas + Alice's seeded timeline event, rebuilt per test so one
  // failure never starves the rest (DEC-UM-010).
  interface Cast {
    aliceId: string;
    bobId: string;
    paulaId: string;
    eveId: string;
  }

  const seedCast = async (): Promise<Cast> => {
    const alice = await fx.user('ct11-alice', {
      firstName: 'Alice',
      position: 'Engineer',
    });
    const bob = await fx.user('ct11-bob', { firstName: 'Bob' });
    const paula = await fx.user('ct11-paula', { firstName: 'Paula' });
    const eve = await fx.user('ct11-eve', { firstName: 'Eve' });

    // Alice reports to Bob (direct manager → `reporting` audience).
    await fx.reportsTo(alice.id, bob.id);
    // Paula is Alice's directly-assigned People Partner (`pp` audience).
    await fx.peoplePartnerOf(alice.id, paula.id);
    // Eve has no edge to Alice at all (Colleague → `—`).

    // At least one event on Alice's timeline — stand-in for the `joined_company`
    // row her seeding would carry (the model + table exist since Story 1.1).
    await testApp.prisma.userEvent.create({
      data: {
        userId: alice.id,
        type: 'joined_company',
        eventDate: new Date('2026-09-01'),
        source: 'system',
        details: {},
        createdBy: alice.id,
      },
    });

    return {
      aliceId: alice.id,
      bobId: bob.id,
      paulaId: paula.id,
      eveId: eve.id,
    };
  };

  const getEvents = (targetId: string, viewerId?: string) => {
    const req = request(testApp.app.getHttpServer()).get(
      `/users/${targetId}/events`,
    );
    return viewerId ? req.set('authorization', bearer(viewerId)) : req;
  };

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await cleanupUserEvents(testApp.prisma, fx.userIds);
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // Stage-2 gate decision (Dmytro 2026-09-02): a 200 returns the standard
  // `{ data, canEdit }` envelope. `canEdit` = the Story 3.2/3.3 manual-mutation
  // gate → `false` for every viewer until Story 3.2 ships.
  it('um-ct-11 Test 1 · Self → 200 { data, canEdit:false } with her own timeline [RED: route GET /users/:id/events does not exist → 404]', async () => {
    const { aliceId } = await seedCast();
    const res = await getEvents(aliceId, aliceId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: false });
    expect((res.body as { data: unknown[] }).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'joined_company', source: 'system' }),
      ]),
    );
  });

  it('um-ct-11 Test 2 · Reporting line (direct manager Bob) → 200 { data, canEdit:false } with Alice’s timeline [RED: route missing → 404]', async () => {
    const { aliceId, bobId } = await seedCast();
    const res = await getEvents(aliceId, bobId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: false });
    expect((res.body as { data: unknown[] }).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'joined_company' }),
      ]),
    );
  });

  it('um-ct-11 Test 3 · Assigned PP (Paula) → 200 { data, canEdit:false } with Alice’s timeline [RED: route missing → 404]', async () => {
    const { aliceId, paulaId } = await seedCast();
    const res = await getEvents(aliceId, paulaId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: false });
    expect((res.body as { data: unknown[] }).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'joined_company' }),
      ]),
    );
  });

  it('um-ct-11 Test 4 · Colleague (Eve, no edge) → 403, body carries no timeline data [RED: route missing → 404, not the target 403]', async () => {
    const { aliceId, eveId } = await seedCast();
    const res = await getEvents(aliceId, eveId);
    expect(res.status).toBe(403);
    // §3.3.1: a `—` cell must not leak — not 200-with-[], not 404.
    expect(JSON.stringify(res.body)).not.toContain('joined_company');
  });

  it('um-ct-11 Test 5 · Unresolved session (no Authorization header) → 401 [RED: route missing → 404; the session guard may 401 once the route exists]', async () => {
    const { aliceId } = await seedCast();
    const res = await getEvents(aliceId);
    expect(res.status).toBe(401);
  });
});
