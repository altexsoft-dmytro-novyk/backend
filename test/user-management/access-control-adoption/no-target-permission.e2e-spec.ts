import request from 'supertest';
import type { TestApp } from './fixtures';
import { RunFixtures, bearer, bootstrapTestApp } from './fixtures';
import { DELIVERED_CSV_HEADER } from '../epic-1/fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1) · AD-1 Stage 2.
 *
 * Scenario: docs/test-cases/user-management/access-control-adoption/
 *   umac-06-no-target-isallowed-delegates-to-facade.md
 *
 * The real adapter's `isAllowed(userId, feature)` delegates straight to
 * `AccessControlFacade.isAllowed`; the interim adapter's
 * `actor.position === 'HR Admin'` string check is deleted. The three no-target
 * routes — `GET /users` (`user-management:list`), `POST /users/import`
 * (`user-management:create`), `DELETE /users/:id` (`user-management:deactivate`)
 * — are exactly the ACM-1 seeded grant set, so a real `hr-admin` FR grant keeps
 * them working and any other session fails closed.
 *
 * `POST /users` was retired by Story 1.1 (AD-21 / AD-16 — the population is a
 * seeded import, not an operator create). `POST /users/import` is now the
 * no-target `user-management:create` route: its `@RequireFeature` guard runs
 * before any multipart parsing, so an unauthorized caller gets `403` regardless
 * of file content, and an authorized caller uploading a header-only (zero-row)
 * CSV gets `200` with an all-zero import summary.
 *
 * WHY RED / GREEN (per test):
 *   - Test 1 (seeded hr-admin root, real FR grant) — **already-green
 *     characterization.** The real facade allows it via the live FR grant chain.
 *     Kept (not skipped) so the delegated allow path stays covered.
 *   - Test 2 (unrelated active user, ordinary position, no FR grant) —
 *     **already-green characterization.** No grant → `403`.
 *   - Test 3 (Ida — holds an unrelated FR permission, not these three) —
 *     **already-green characterization.** Holding *a* permission is not holding
 *     *this* one (DEC-UM-002).
 *   - Test 4 (impostor — `User.position = 'HR Admin'` but NO FR grant) —
 *     **GREEN after UMAC-1 production.** The interim adapter's prohibited
 *     role-name check (`access-control.md:49` / AD-4) is gone; the real facade
 *     denies the impostor because no FR grant chain exists → `403` on all three.
 *     This was the committed-red heart of UMAC-06; it flipped green when
 *     UMAC-1-production bound the real facade adapter.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. The FR grant chain is seeded in-suite (mirrors
 * acm2-is-allowed.e2e-spec.ts) rather than assumed from a prior bootstrap.
 */
describe('UMAC-1 Stage 2 — UMAC-06 no-target isAllowed delegates to the real facade (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  // A header-only (zero data row) CSV with the delivered semicolon header
  // verbatim. Enough for a `200` on an authorized import (summary is all zeros);
  // for a denied caller the guard rejects before this is ever parsed.
  const emptyPopulationCsv = (): Buffer =>
    Buffer.from(`${DELIVERED_CSV_HEADER}\n`);

  const listUsers = (viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get('/users')
      .set('authorization', bearer(viewerId));

  const importPopulation = (viewerId: string) =>
    request(testApp.app.getHttpServer())
      .post('/users/import')
      .set('authorization', bearer(viewerId))
      .attach('file', emptyPopulationCsv(), 'p.csv');

  const deactivateUser = (viewerId: string, targetId: string) =>
    request(testApp.app.getHttpServer())
      .delete(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

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

  it('UMAC-06 Test 1 — seeded hr-admin root is allowed on list / import / deactivate (already-green characterization)', async () => {
    const root = await fx.user('umac06-root', { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id);
    const deactivationTarget = await fx.user('umac06-target1');

    const list = await listUsers(root.id);
    expect(list.status).toBe(200);

    const importResult = await importPopulation(root.id);
    expect(importResult.status).toBe(200);
    expect(importResult.body).toMatchObject({ created: 0 });

    const deactivate = await deactivateUser(root.id, deactivationTarget.id);
    expect(deactivate.status).toBe(200);
  });

  it('UMAC-06 Test 2 — unrelated active user with no FR grant is denied 403 on all three (already-green characterization)', async () => {
    const unrelated = await fx.user('umac06-unrelated', {
      position: 'Engineer',
    });
    const target = await fx.user('umac06-target2');

    expect((await listUsers(unrelated.id)).status).toBe(403);
    // The `@RequireFeature` guard denies before any multipart parsing.
    expect((await importPopulation(unrelated.id)).status).toBe(403);
    expect((await deactivateUser(unrelated.id, target.id)).status).toBe(403);
  });

  it('UMAC-06 Test 3 — Ida holds an unrelated FR permission, not these three → 403 (already-green characterization, DEC-UM-002)', async () => {
    const ida = await fx.user('umac06-ida', { position: 'Engineer' });
    // A real FR grant chain for a DIFFERENT permission key.
    await fx.grantFunctionalRole(ida.id, [`umac06:unrelated-${fx.runId}`]);
    const target = await fx.user('umac06-target3');

    expect((await listUsers(ida.id)).status).toBe(403);
    expect((await importPopulation(ida.id)).status).toBe(403);
    expect((await deactivateUser(ida.id, target.id)).status).toBe(403);
  });

  it('UMAC-06 Test 4 — impostor with User.position = "HR Admin" but NO FR grant → 403 on all three (GREEN)', async () => {
    // The interim adapter ALLOWED this via the prohibited `position === "HR Admin"`
    // role-name check; the real facade denies it because no FR grant chain
    // exists. This was the committed-red heart of UMAC-06 — green since
    // UMAC-1-production bound the real facade adapter.
    const impostor = await fx.user('umac06-impostor', { position: 'HR Admin' });
    const target = await fx.user('umac06-target4');

    const list = await listUsers(impostor.id);
    expect(list.status).toBe(403);

    const importResult = await importPopulation(impostor.id);
    expect(importResult.status).toBe(403);

    const deactivate = await deactivateUser(impostor.id, target.id);
    expect(deactivate.status).toBe(403);
  });
});
