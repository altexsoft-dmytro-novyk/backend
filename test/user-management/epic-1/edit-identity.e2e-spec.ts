import request from 'supertest';
import {
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
} from './fixtures';
import { S1_CARD_FIELDS, s1CardOf } from '../access-control-adoption/fixtures';

/**
 * Epic 1 — Story 1.2 (View and Edit an Employee's Identity-Card Fields) ·
 * AD-1 Stage 2 · committed-red real-consumer HTTP E2E for `PATCH /users/:id`
 * DATA-CORRECTNESS. One `describe` per approved Stage-1 scenario, id in the
 * title:
 *   docs/test-cases/user-management/profile/
 *     um-edit-01-entitled-actor-edits-identity-fields.md
 *     um-edit-02-workemail-normalized-before-uniqueness-check.md
 *     um-edit-03-duplicate-workemail-rejected-wholesale.md
 *     um-edit-04-duplicate-ttid-rejected-wholesale.md
 *     um-edit-05-org-fields-in-body-rejected.md
 *     um-edit-06-forbidden-technical-fields-rejected.md
 *     um-edit-07-empty-or-no-op-patch.md
 *     um-edit-08-birthday-pair-both-or-neither.md
 *   + docs/test-cases/user-management/profile/README.md (the acceptance criteria)
 *
 * SUPERSEDES `epic-1/profile-v15.e2e-spec.ts` (deleted in the same change): its
 * `um-pf-01` / `um-pf-03` / `um-pf-04` blocks are the pre-v1.5 Story 1.2 edit
 * scenarios, retired in place by the `um-edit-*` set; its `um-pf-02` photo block
 * is superseded by `um-photo-*`, already covered by `photo-v15.e2e-spec.ts`.
 * profile-v15's header itself said "every `it` currently 403s" — that stale
 * all-403 suite is removed, not left behind.
 *
 * ── SCOPE — data correctness, not entitlement ──────────────────────────────
 * *Who* may `PATCH /users/:id` (Variant A: `canAccessSection(v, 'S1', t) ===
 * 'write'` alone — reporting-line manager or assigned People Partner) is
 * asserted canonically by Epic 0 in
 * `access-control-adoption/write-adoption.e2e-spec.ts` (umac-07/08). This suite
 * does NOT re-test the gate: every test seeds an ALREADY-ENTITLED actor (Bob via
 * `fx.reportsTo`, or Paula via `fx.peoplePartnerOf`) so the request reaches
 * `EditUserAction` / `UpdateUserDto`, and asserts only what the write does to
 * the data.
 *
 * ── AD-3: real everything, no provider override ────────────────────────────
 * Real `AppModule`, real Prisma against migrated PostgreSQL, real
 * `AccessControlFacade`. Fixtures seed real `User` + `Relationship` rows and
 * issue `Bearer <token:<seeded-uuid>>` (never a `<token:Bob>` literal, which
 * resolves to the string id `'Bob'` → empty audience → 403).
 * DEC-UM-010: one worker (`--runInBand`), run-namespaced rows, wrapped teardown.
 *
 * ── RED / GREEN (why RED, per README "Why RED") ────────────────────────────
 * GREEN today (already-green characterization — locks the behaviour in):
 *   um-edit-01  — the entitled-actor partial-merge write + envelope readback
 *                 (same path as write-adoption umac-07 Test 1/2, GREEN).
 *   um-edit-02  — `workEmail` `@Transform(trim().toLowerCase())` runs in the DTO
 *                 before the patch reaches the unique index, so normalization
 *                 already precedes the uniqueness check.
 *   um-edit-03  — `prisma.user.update` is a single atomic statement; a P2002 on
 *                 `workEmail` fails the whole update (→ 409 via
 *                 `user.repository.ts` `mapKnownError`), the sibling `position`
 *                 never lands, the collided row is untouched.
 *   um-edit-04  — same, for the `ttId` unique index; `null` vs `null` is not a
 *                 unique-index collision in Postgres.
 *   um-edit-06 T1/T2/T5 — `photo` / `isActive` / `id` / `createdAt` / `createdBy`
 *                 are already `@IsEmpty()` on `UpdateUserDto` → 400.
 *   um-edit-07  — empty / no-op body: `EditUserAction` builds an empty patch and
 *                 `prisma.user.update` with `{}` is a harmless no-op → 200.
 *   um-edit-08 T2/T3/T4 — setting both halves, changing one half of a whole
 *                 pair, and clearing both halves all pass the current DTO.
 * RED — committed-red until Story 1.2 Stage 3:
 *   um-edit-05  — `UpdateUserDto` declares no `manager` / `managerId` /
 *                 `reportsToUserId` / `peoplePartner` / `peoplePartnerId` /
 *                 `department` / `departmentId`; the global `ValidationPipe` is
 *                 `whitelist`-only (no `forbidNonWhitelisted`), so these keys are
 *                 SILENTLY STRIPPED and the request 200s on the sibling
 *                 `position`. Stage 3 adds explicit `@IsEmpty()` (shared with
 *                 write-adoption umac-08). Expected: 400.
 *   um-edit-06 T3/T4 — `employmentStatus` / `customFields` are likewise not
 *                 declared on the DTO → silently stripped → 200. Stage 3 makes
 *                 the rejection explicit (400).
 *   um-edit-08 T1/T5 — the birthday-pair invariant ("both null or both set") is
 *                 not enforced on the edit path: a `PATCH` leaving exactly one
 *                 half non-null currently 200s. Stage 3 rejects it (400).
 */

type Envelope = { data: Record<string, unknown>; canEdit: boolean };

describe('Epic 1 · Story 1.2 — PATCH /users/:id identity-card data correctness (e2e)', () => {
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

  const patch = (
    targetId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .patch(`/users/${targetId}`)
      .set('authorization', bearer(viewerId))
      .send(body);

  const getUser = (targetId: string, viewerId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  const rowOf = (id: string) =>
    testApp.prisma.user.findUnique({ where: { id } });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-01 — an entitled actor edits S1 identity fields; a read reflects it
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-01 · entitled actor edits S1 identity fields [GREEN: characterization]', () => {
    it('um-edit-01 Test 1/2 — reporting-line manager PATCH { position, country, city, workPhone } → 200 partial merge; follow-up GET envelope reflects it', async () => {
      const bob = await fx.user('e01-bob', { firstName: 'Bob' });
      const alice = await fx.user('e01-alice', {
        firstName: 'Alice',
        position: 'Engineer',
        country: 'PL',
        city: 'Warsaw',
        workPhone: null,
      });
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });
      expect(write.status).toBe(200);
      // Response is the plain `toUserResponse` shape, NOT the `{ data, canEdit }`
      // envelope (that is GET /users/:id only — profile/README "Response body").
      expect(write.body).toMatchObject({
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });
      // Partial merge: every unlisted S1 field is untouched.
      const wb = write.body as Record<string, unknown>;
      expect(wb.firstName).toBe(alice.firstName);
      expect(wb.lastName).toBe(alice.lastName);
      expect(wb.workEmail).toBe(alice.workEmail);
      expect(wb.birthDay).toBe(alice.birthDay);
      expect(wb.birthMonth).toBe(alice.birthMonth);
      expect(wb.ttId).toBeNull();
      expect(wb.companyJoinDate).toBe(
        alice.companyJoinDate.toISOString().slice(0, 10),
      );

      // Test 2 — the change is observable on GET, in the CAP-3 envelope, and
      // `canEdit` is true for a reporting-line viewer (Variant A whole gate).
      const read = await getUser(alice.id, bob.id);
      expect(read.status).toBe(200);
      const card = read.body as Envelope;
      expect(card.canEdit).toBe(true);
      expect(card.data.position).toBe('Senior Engineer');
      expect(card.data.country).toBe('DE');
      expect(card.data.city).toBe('Berlin');
      expect(card.data.workPhone).toBe('+49 30 000000');
      // `data` carries exactly the 12 S1-card keys — no ttId / isActive /
      // customFields / createdAt / createdBy.
      expect(Object.keys(card.data).sort()).toEqual([...S1_CARD_FIELDS].sort());
      const persisted = await rowOf(alice.id);
      expect(card.data).toEqual(s1CardOf(persisted!));
    });

    it('um-edit-01 (README "Also an assigned PP → 200") — assigned People Partner PATCH { position } → 200, persists', async () => {
      const paula = await fx.user('e01-paula', { firstName: 'Paula' });
      const alice = await fx.user('e01pp-alice', { position: 'Engineer' });
      await fx.peoplePartnerOf(alice.id, paula.id);

      const write = await patch(alice.id, paula.id, {
        position: 'Staff Engineer',
      });
      expect(write.status).toBe(200);
      expect((write.body as Record<string, unknown>).position).toBe(
        'Staff Engineer',
      );

      const read = await getUser(alice.id, paula.id);
      expect(read.body as Envelope).toMatchObject({
        data: { position: 'Staff Engineer' },
        canEdit: true,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-02 — workEmail normalized (trim().toLowerCase()) BEFORE the check
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-02 · workEmail normalized before the uniqueness check [GREEN: characterization]', () => {
    it('um-edit-02 Test 1 — PATCH { workEmail: "  Alice.New@Company.EXAMPLE  " } → 200, stored/returned normalized', async () => {
      const bob = await fx.user('e02-bob', { firstName: 'Bob' });
      const alice = await fx.user('e02-alice', { firstName: 'Alice' });
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        workEmail: '  Alice.New@Company.EXAMPLE  ',
      });
      expect(write.status).toBe(200);
      expect((write.body as Record<string, unknown>).workEmail).toBe(
        'alice.new@company.example',
      );

      const read = await getUser(alice.id, bob.id);
      expect((read.body as Envelope).data.workEmail).toBe(
        'alice.new@company.example',
      );
    });

    it('um-edit-02 Test 2 — PATCH { workEmail } that collides ONLY after normalization → 409, Alice unchanged', async () => {
      const bob = await fx.user('e02t2-bob', { firstName: 'Bob' });
      const colin = await fx.user('e02t2-colin', { firstName: 'Colin' });
      const alice = await fx.user('e02t2-alice', { firstName: 'Alice' });
      await fx.reportsTo(alice.id, bob.id);

      // Colin's stored address, supplied with a different case and outer
      // whitespace: byte-identical to the stored value ONLY once normalized.
      const raw = `  ${colin.workEmail.toUpperCase()} `;
      const write = await patch(alice.id, bob.id, { workEmail: raw });
      expect(write.status).toBe(409);

      const read = await getUser(alice.id, bob.id);
      expect((read.body as Envelope).data.workEmail).toBe(alice.workEmail);
    });

    it('um-edit-02 (README) — PATCH { workEmail } normalizing to the row’s own current value → 200 no-op', async () => {
      const bob = await fx.user('e02t3-bob', { firstName: 'Bob' });
      const alice = await fx.user('e02t3-alice', { firstName: 'Alice' });
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        workEmail: `  ${alice.workEmail.toUpperCase()}  `,
      });
      expect(write.status).toBe(200);
      expect((write.body as Record<string, unknown>).workEmail).toBe(
        alice.workEmail,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-03 — workEmail conflict rejects the WHOLE write (409), nothing partial
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-03 · duplicate workEmail rejected wholesale [GREEN: characterization]', () => {
    it('um-edit-03 Test 1/2 — PATCH { position, workEmail: <in use> } → 409; neither field changes; the collided row is untouched', async () => {
      const bob = await fx.user('e03-bob', { firstName: 'Bob' });
      const colin = await fx.user('e03-colin', { firstName: 'Colin' });
      const alice = await fx.user('e03-alice', {
        firstName: 'Alice',
        position: 'Engineer',
      });
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        position: 'Staff Engineer',
        workEmail: colin.workEmail,
      });
      expect(write.status).toBe(409);

      // Test 1 — neither workEmail nor the sibling position slipped through.
      const readAlice = await getUser(alice.id, bob.id);
      expect((readAlice.body as Envelope).data.workEmail).toBe(alice.workEmail);
      expect((readAlice.body as Envelope).data.position).toBe('Engineer');

      // Test 2 — Colin's row is untouched (Bob is at least a colleague of Colin).
      const readColin = await getUser(colin.id, bob.id);
      expect(readColin.status).toBe(200);
      expect((readColin.body as Envelope).data.workEmail).toBe(colin.workEmail);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-04 — ttId conflict rejects wholesale (409); null-vs-null is not a dup
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-04 · duplicate ttId rejected wholesale; null-vs-null OK [GREEN: characterization]', () => {
    it('um-edit-04 Test 1 — PATCH { workPhone, ttId: <in use> } → 409; neither ttId nor workPhone changes', async () => {
      const bob = await fx.user('e04-bob', { firstName: 'Bob' });
      const ttId = `tt-${fx.runId.slice(-12)}`;
      await fx.user('e04-colin', { firstName: 'Colin', ttId });
      const alice = await fx.user('e04-alice', {
        firstName: 'Alice',
        workPhone: null,
      });
      expect(alice.ttId).toBeNull();
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        workPhone: '+48 22 000000',
        ttId,
      });
      expect(write.status).toBe(409);

      // `ttId` is not an S1-card field (AD-13) — assert directly against the row.
      const persisted = await rowOf(alice.id);
      expect(persisted?.ttId).toBeNull();
      expect(persisted?.workPhone).toBeNull();
    });

    it('um-edit-04 Test 2 — unrelated edit while Alice and Nina both hold ttId: null → 200, no 409', async () => {
      const bob = await fx.user('e04t2-bob', { firstName: 'Bob' });
      const nina = await fx.user('e04t2-nina', { firstName: 'Nina' });
      const alice = await fx.user('e04t2-alice', {
        firstName: 'Alice',
        position: 'Engineer',
      });
      expect(nina.ttId).toBeNull();
      expect(alice.ttId).toBeNull();
      await fx.reportsTo(alice.id, bob.id);

      const write = await patch(alice.id, bob.id, {
        position: 'Senior Engineer',
      });
      expect(write.status).toBe(200);
      expect((write.body as Record<string, unknown>).position).toBe(
        'Senior Engineer',
      );
      const persisted = await rowOf(alice.id);
      expect(persisted?.ttId).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-05 — org fields in the body → whole DTO 400  [RED until Stage 3]
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-05 · org fields (manager / peoplePartner / department) in the body → 400 [RED]', () => {
    // RED: none of these keys is declared on `UpdateUserDto`; the global pipe is
    // whitelist-only, so today they are silently stripped and the request 200s
    // on the sibling `position`. Stage 3 adds `@IsEmpty()` (shared with umac-08).
    const seedEntitled = async (tag: string) => {
      const bob = await fx.user(`e05-bob-${tag}`, { firstName: 'Bob' });
      const paula = await fx.user(`e05-paula-${tag}`, { firstName: 'Paula' });
      const nina = await fx.user(`e05-nina-${tag}`, { firstName: 'Nina' });
      const alice = await fx.user(`e05-alice-${tag}`, { position: 'Engineer' });
      await fx.reportsTo(alice.id, bob.id);
      await fx.peoplePartnerOf(alice.id, paula.id);
      return { bob, paula, nina, alice };
    };

    it('um-edit-05 Test 1 — { position, managerId } → 400; position not applied; direct edge + journal unchanged [RED]', async () => {
      const { bob, nina, alice } = await seedEntitled('mgrid');
      const res = await patch(alice.id, bob.id, {
        position: 'Senior Engineer',
        managerId: nina.id,
      });
      expect(res.status).toBe(400);

      const read = await getUser(alice.id, bob.id);
      expect((read.body as Envelope).data.position).toBe('Engineer');
      const edge = await testApp.prisma.relationship.findFirst({
        where: { userId: alice.id, type: 'direct' },
      });
      expect(edge?.reportsToUserId).toBe(bob.id);
      const journal = await testApp.prisma.userEvent.count({
        where: { userId: alice.id },
      });
      expect(journal).toBe(0);
    });

    it('um-edit-05 Test 2 — { peoplePartnerId } → 400; people_partner edge unchanged [RED]', async () => {
      const { bob, paula, nina, alice } = await seedEntitled('ppid');
      const res = await patch(alice.id, bob.id, { peoplePartnerId: nina.id });
      expect(res.status).toBe(400);
      const edge = await testApp.prisma.relationship.findFirst({
        where: { userId: alice.id, type: 'people_partner' },
      });
      expect(edge?.reportsToUserId).toBe(paula.id);
    });

    it('um-edit-05 Test 3 — { departmentId } → 400 [RED]', async () => {
      const { bob, alice } = await seedEntitled('deptid');
      const res = await patch(alice.id, bob.id, {
        departmentId: '01890000-0000-7000-8000-0000000005de',
      });
      expect(res.status).toBe(400);
    });

    it('um-edit-05 Test 4 — the bare-name aliases (manager / reportsToUserId / peoplePartner / department) are each rejected 400, none silently stripped [RED]', async () => {
      const { bob, nina, alice } = await seedEntitled('aliases');
      for (const field of [
        'manager',
        'reportsToUserId',
        'peoplePartner',
        'department',
      ]) {
        const res = await patch(alice.id, bob.id, {
          position: 'Senior Engineer',
          [field]: nina.id,
        });
        expect({ field, status: res.status }).toEqual({ field, status: 400 });
      }
      const read = await getUser(alice.id, bob.id);
      expect((read.body as Envelope).data.position).toBe('Engineer');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-06 — technical fields outside the S1 scalar surface → 400
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-06 · forbidden technical fields → 400', () => {
    const seedEntitled = async (tag: string) => {
      const bob = await fx.user(`e06-bob-${tag}`, { firstName: 'Bob' });
      const alice = await fx.user(`e06-alice-${tag}`, {
        firstName: 'Alice',
        position: 'Engineer',
      });
      await fx.reportsTo(alice.id, bob.id);
      return { bob, alice };
    };

    it('um-edit-06 Test 1 — { photo } → 400; Alice’s photo unchanged [GREEN: @IsEmpty]', async () => {
      const { bob, alice } = await seedEntitled('photo');
      const res = await patch(alice.id, bob.id, { photo: 'photos/x/y' });
      expect(res.status).toBe(400);
      expect((await rowOf(alice.id))?.photo).toBe(alice.photo);
    });

    it('um-edit-06 Test 2 — { isActive: false } → 400; Alice still active [GREEN: @IsEmpty]', async () => {
      const { bob, alice } = await seedEntitled('isactive');
      const res = await patch(alice.id, bob.id, { isActive: false });
      expect(res.status).toBe(400);
      expect((await rowOf(alice.id))?.isActive).toBe(true);
    });

    it('um-edit-06 Test 3 — { employmentStatus: "dismissed" } → 400 [RED: not declared on the DTO → silently stripped → 200 today]', async () => {
      const { bob, alice } = await seedEntitled('empstatus');
      const res = await patch(alice.id, bob.id, {
        employmentStatus: 'dismissed',
      });
      expect(res.status).toBe(400);
      expect((await rowOf(alice.id))?.position).toBe('Engineer');
    });

    it('um-edit-06 Test 4 — { customFields } → 400 [RED: not declared on the DTO → silently stripped → 200 today]', async () => {
      const { bob, alice } = await seedEntitled('customfields');
      const res = await patch(alice.id, bob.id, {
        customFields: { shoeSize: 42 },
      });
      expect(res.status).toBe(400);
      const persisted = await rowOf(alice.id);
      expect(persisted?.customFields).toEqual({});
    });

    it('um-edit-06 Test 5 — { id } / { createdAt } / { createdBy } → 400 each [GREEN: @IsEmpty]', async () => {
      const { bob, alice } = await seedEntitled('audit');
      for (const [field, value] of [
        ['id', '01890000-0000-7000-8000-00000000060a'],
        ['createdAt', '2020-01-01T00:00:00.000Z'],
        ['createdBy', '01890000-0000-7000-8000-00000000060b'],
      ]) {
        const res = await patch(alice.id, bob.id, { [field]: value });
        expect({ field, status: res.status }).toEqual({ field, status: 400 });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-07 — empty / no-op PATCH → 200 (in-scenario decision)
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-07 · empty / no-op PATCH → 200 [GREEN: characterization]', () => {
    it('um-edit-07 Test 1 — empty body {} → 200, current state echoed', async () => {
      const bob = await fx.user('e07-bob', { firstName: 'Bob' });
      const alice = await fx.user('e07-alice', { position: 'Engineer' });
      await fx.reportsTo(alice.id, bob.id);

      const res = await patch(alice.id, bob.id, {});
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).position).toBe('Engineer');
    });

    it('um-edit-07 Test 2 — body equal to current state → 200; a follow-up GET is byte-identical to one taken before', async () => {
      const bob = await fx.user('e07t2-bob', { firstName: 'Bob' });
      const alice = await fx.user('e07t2-alice', { position: 'Engineer' });
      await fx.reportsTo(alice.id, bob.id);

      const before = await getUser(alice.id, bob.id);
      const res = await patch(alice.id, bob.id, { position: 'Engineer' });
      expect(res.status).toBe(200);
      const after = await getUser(alice.id, bob.id);
      expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // um-edit-08 — birthDay / birthMonth: both-or-neither on edit
  // ───────────────────────────────────────────────────────────────────────────
  describe('um-edit-08 · birthday pair — both or neither', () => {
    const seedAlice = async (
      tag: string,
      birthDay: number | null,
      birthMonth: number | null,
    ) => {
      const bob = await fx.user(`e08-bob-${tag}`, { firstName: 'Bob' });
      const alice = await fx.user(`e08-alice-${tag}`, {
        firstName: 'Alice',
        birthDay,
        birthMonth,
      });
      await fx.reportsTo(alice.id, bob.id);
      return { bob, alice };
    };

    it('um-edit-08 Test 1 — { birthDay: 14 } alone, row has neither → 400; row unchanged [RED: pair invariant not enforced on edit → 200 today]', async () => {
      const { bob, alice } = await seedAlice('t1', null, null);
      const res = await patch(alice.id, bob.id, { birthDay: 14 });
      expect(res.status).toBe(400);
      const persisted = await rowOf(alice.id);
      expect(persisted?.birthDay).toBeNull();
      expect(persisted?.birthMonth).toBeNull();
    });

    it('um-edit-08 Test 2 — { birthDay: 14, birthMonth: 3 } → 200 [GREEN]', async () => {
      const { bob, alice } = await seedAlice('t2', null, null);
      const res = await patch(alice.id, bob.id, {
        birthDay: 14,
        birthMonth: 3,
      });
      expect(res.status).toBe(200);
      const persisted = await rowOf(alice.id);
      expect(persisted?.birthDay).toBe(14);
      expect(persisted?.birthMonth).toBe(3);
    });

    it('um-edit-08 Test 3 — one half changed while the pair is whole → 200 [GREEN]', async () => {
      const { bob, alice } = await seedAlice('t3', 14, 3);
      const res = await patch(alice.id, bob.id, { birthMonth: 5 });
      expect(res.status).toBe(200);
      const persisted = await rowOf(alice.id);
      expect(persisted?.birthDay).toBe(14);
      expect(persisted?.birthMonth).toBe(5);
    });

    it('um-edit-08 Test 4 — { birthDay: null, birthMonth: null } clears both → 200 [GREEN]', async () => {
      const { bob, alice } = await seedAlice('t4', 14, 3);
      const res = await patch(alice.id, bob.id, {
        birthDay: null,
        birthMonth: null,
      });
      expect(res.status).toBe(200);
      const persisted = await rowOf(alice.id);
      expect(persisted?.birthDay).toBeNull();
      expect(persisted?.birthMonth).toBeNull();
    });

    it('um-edit-08 Test 5 — { birthMonth: null } from a whole pair → 400; row unchanged [RED: half-clear not rejected on edit → 200 today]', async () => {
      const { bob, alice } = await seedAlice('t5', 14, 5);
      const res = await patch(alice.id, bob.id, { birthMonth: null });
      expect(res.status).toBe(400);
      const persisted = await rowOf(alice.id);
      expect(persisted?.birthDay).toBe(14);
      expect(persisted?.birthMonth).toBe(5);
    });
  });
});
