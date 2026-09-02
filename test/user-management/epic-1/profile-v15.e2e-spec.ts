import request from 'supertest';
import { RunFixtures, type TestApp, bootstrapTestApp } from './fixtures';

/**
 * Epic 1 — Stories 1.2 / 1.3 (View and Edit an Employee's Identity-Card Fields;
 * Self Uploads Own Photo) · AD-1 Stage 2.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/profile/
 *     um-pf-01-manager-update-identity-fields.md
 *     um-pf-02-self-upload-photo.md
 *     um-pf-03-update-work-email-duplicate-denied.md
 *     um-pf-04-update-tt-id-duplicate-denied.md
 *
 * SCOPE. These files assert **data correctness given an already-entitled
 * actor** — the write persists / a uniqueness conflict is rejected wholesale.
 * *Who* is entitled (Self / reporting / PP allowed, colleague denied, the §2.2
 * dual gate) is **Epic 0's**, asserted committed-red against the real facade in
 * `test/user-management/access-control-adoption/{read,write}-adoption.e2e-spec.ts`
 * (umac-01..09). Per `nest-e2e.md` ("Session/authorization stays out of scope
 * for this suite if its own docs say so") and the `profile/` scope notes,
 * `Bearer <token:Bob>` / `<token:Alice>` stay **literal placeholders** here;
 * they resolve through `InterimSessionResolverAdapter` to `{ userId: 'Bob' }` /
 * `{ userId: 'Alice' }` and the interim `isAllowedForTarget` returns
 * `Boolean(userId)` — so every write is permitted regardless of the seeded
 * edge. The preconditions (Alice/Bob/Colin rows, the `direct` edge) are still
 * **real Prisma inserts** — there is no `POST /users` in v1.5.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *  um-pf-01 / 03 / 04  GREEN — already-green characterization. `PATCH /users/:id`
 *              is wired, the interim adapter permits, `EditUserAction` persists
 *              the scalar S1 patch, and the repository maps a `P2002` unique
 *              violation to `409` (`user.repository.ts:88`). These lock in the
 *              data-correctness behaviour so the AD-21 fixture cutover (seed
 *              rows instead of `POST /users`) cannot silently regress it.
 *  um-pf-02   GREEN — characterization, provided LocalStack S3 is reachable
 *              (`docker compose up` brings it up; `AWS_ENDPOINT_URL` must point
 *              at it). If S3 is down this test is red on storage setup, not on
 *              behaviour — noted, not a behaviour failure.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. DEC-UM-010: one worker, run-namespaced rows, wrapped teardown.
 *
 * ── 2026-09-01 (UMAC-1 Stage 3) — GET assertions made envelope-aware ────────
 * `GET /users/:id` now returns the CAP-3 `{ data, canEdit }` envelope, so the
 * follow-up reads below assert `res.body.data.*` and `canEdit === false`.
 * KNOWN REGRESSION, not fixed here: the write calls themselves (`PATCH`,
 * `PUT .../photo`) now hit the real fail-closed facade — `user-management:edit`
 * / `user-management:upload-photo` are unseeded and the target-scoped write
 * gate is UMAC-2's to implement — so every `it` in this suite currently ends
 * in `403`. This suite depends on BOTH the interim session resolver's lax
 * `Bearer <token:Bob>` AND the retired interim adapter's `Boolean(userId)`
 * write allowance; it needs the same real-seeded-UUID + real-edge fixture
 * rework the e2e audit assigns to `profile.e2e-spec.ts`, plus the UMAC-2 write
 * gate, before it can be green again. Tracked as a follow-up.
 */

const BOB = 'Bearer <token:Bob>'; // literal placeholder — see scope note
const ALICE = 'Bearer <token:Alice>'; // literal placeholder — see scope note

describe('Epic 1 · Profile data correctness — PATCH /users/:id, PUT /users/:id/photo (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  const server = () => testApp.app.getHttpServer();

  // docs/test-cases/user-management/profile/um-pf-01-manager-update-identity-fields.md
  describe('um-pf-01 · manager-line edit to identity fields persists', () => {
    it('the PATCH persists position/city and a follow-up GET reflects them [GREEN: characterization]', async () => {
      const bob = await fx.user('pf01-bob', { firstName: 'Bob' });
      const alice = await fx.user('pf01-alice', {
        firstName: 'Alice',
        position: 'Engineer',
        city: 'Warsaw',
      });
      // Real `direct` edge Alice -> Bob (Bob is Alice's Unit Manager). Under the
      // interim adapter it is not consulted; Epic 0 makes it load-bearing.
      await fx.reportsTo(alice.id, bob.id);

      const write = await request(server())
        .patch(`/users/${alice.id}`)
        .set('authorization', BOB)
        .send({ position: 'Senior Engineer', city: 'Krakow' });
      expect(write.status).toBe(200);
      expect(write.body).toMatchObject({
        position: 'Senior Engineer',
        city: 'Krakow',
      });

      const read = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', BOB);
      expect(read.status).toBe(200);
      // CAP-3: GET /users/:id now returns the `{ data, canEdit }` envelope.
      const card = read.body as {
        data: Record<string, unknown>;
        canEdit: boolean;
      };
      expect(card.data).toMatchObject({
        position: 'Senior Engineer',
        city: 'Krakow',
      });
      expect(card.canEdit).toBe(false);
    });
  });

  // docs/test-cases/user-management/profile/um-pf-02-self-upload-photo.md
  describe('um-pf-02 · Self photo upload persists', () => {
    it('PUT .../photo stores a reference and a follow-up GET reflects it [GREEN: characterization; needs LocalStack S3]', async () => {
      const alice = await fx.user('pf02-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const write = await request(server())
        .put(`/users/${alice.id}/photo`)
        .set('authorization', ALICE)
        .attach('photo', Buffer.from('fake-jpeg-bytes'), 'alice.jpg');
      expect(write.status).toBe(200);
      const writeBody = write.body as { photo?: unknown };
      expect(writeBody.photo).toBeDefined();
      expect(writeBody.photo).not.toBeNull();

      const read = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', ALICE);
      expect(read.status).toBe(200);
      expect((read.body as { data: { photo?: unknown } }).data.photo).toBe(
        writeBody.photo,
      );
    });
  });

  // docs/test-cases/user-management/profile/um-pf-03-update-work-email-duplicate-denied.md
  describe('um-pf-03 · editing workEmail to an address already in use is rejected', () => {
    it('PATCH workEmail to Colin’s address → 409, Alice’s workEmail unchanged [GREEN: characterization]', async () => {
      const colin = await fx.user('pf03-colin', { firstName: 'Colin' });
      const alice = await fx.user('pf03-alice', { firstName: 'Alice' });
      const aliceEmailBefore = alice.workEmail;

      const write = await request(server())
        .patch(`/users/${alice.id}`)
        .set('authorization', BOB)
        .send({ workEmail: colin.workEmail });
      expect(write.status).toBe(409);

      const read = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', BOB);
      expect(read.status).toBe(200);
      expect(
        (read.body as { data: { workEmail: string } }).data.workEmail,
      ).toBe(aliceEmailBefore);
      expect(
        (read.body as { data: { workEmail: string } }).data.workEmail,
      ).not.toBe(colin.workEmail);
    });
  });

  // docs/test-cases/user-management/profile/um-pf-04-update-tt-id-duplicate-denied.md
  describe('um-pf-04 · setting ttId to a value already in use is rejected', () => {
    it('PATCH ttId to a value Colin holds → 409, Alice’s ttId unchanged (null) [GREEN: characterization]', async () => {
      const ttId = `tt-${fx.runId.slice(-12)}`;
      await fx.user('pf04-colin', { firstName: 'Colin', ttId });
      const alice = await fx.user('pf04-alice', { firstName: 'Alice' });
      expect(alice.ttId).toBeNull(); // precondition: Alice seeded with ttId null

      const write = await request(server())
        .patch(`/users/${alice.id}`)
        .set('authorization', BOB)
        .send({ ttId });
      expect(write.status).toBe(409);

      // `ttId` is not an S1-card field (AD-13) so the `{ data }` envelope never
      // carries it — verify the rejected PATCH left it untouched at the source.
      const persisted = await testApp.prisma.user.findUnique({
        where: { id: alice.id },
      });
      expect(persisted?.ttId).toBeNull();
    });
  });
});
