import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { TestApp } from './fixtures';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectLeakFreeBody,
} from './fixtures';

/**
 * CONFLICT-UM-01 — the regenerated PM/AD-24 denial oracle for the two
 * `@RequireSectionAccess('profile:identity', …)` routes.
 *
 * Scenario: docs/test-cases/user-management/access-control-adoption/
 *   umac-11-hidden-target-denial-oracle.md
 *
 * Precedence: `401` (session) → `404` (target is not an active `User`, resolved
 * before ANY section or feature check) → `403` (visible target, insufficient
 * section level). Supersedes the empty-audience `403` pinned by `umac-05`
 * Test 3 and `s41c-sag-01` Tests 5–6.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides.
 */
describe('UMAC-11 — GET/PATCH /users/:id: 401 session → 404 hidden target → 403 visible (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const getUser = (targetId: string, authorization: string) =>
    request(testApp.app.getHttpServer())
      .get(`/users/${targetId}`)
      .set('authorization', authorization);

  const patchUser = (
    targetId: string,
    authorization: string,
    body: Record<string, unknown>,
  ) =>
    request(testApp.app.getHttpServer())
      .patch(`/users/${targetId}`)
      .set('authorization', authorization)
      .send(body);

  const cityOf = async (userId: string): Promise<string | null | undefined> => {
    const row = await testApp.prisma.user.findUnique({
      where: { id: userId },
      select: { city: true },
    });
    return row?.city;
  };

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

  it('umac-11 Test 1 · GET of a missing target id by an active caller → 404, leak-free', async () => {
    const viewer = await fx.user('umac11-viewer');

    const res = await getUser(uuidv7(), bearer(viewer.id));

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body);
  });

  it('umac-11 Test 2 · GET of an inactive target → 404, leak-free', async () => {
    const viewer = await fx.user('umac11-viewer');
    const target = await fx.user('umac11-inactive-target', {
      isActive: false,
    });

    const res = await getUser(target.id, bearer(viewer.id));

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body, target);
  });

  it('umac-11 Test 3 · PATCH of a missing target id → 404 before the mutation check', async () => {
    const viewer = await fx.user('umac11-viewer');

    const res = await patchUser(uuidv7(), bearer(viewer.id), {
      city: 'Berlin',
    });

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body);
  });

  it('umac-11 Test 4 · PATCH of an inactive target by its former reporting-line manager → 404, row unchanged', async () => {
    const manager = await fx.user('umac11-manager');
    const target = await fx.user('umac11-report', { city: 'Krakow' });
    await fx.reportsTo(target.id, manager.id);
    // Fixture setup only: deactivate the target after the real edge exists.
    await testApp.prisma.user.update({
      where: { id: target.id },
      data: { isActive: false },
    });

    const res = await patchUser(target.id, bearer(manager.id), {
      city: 'Berlin',
    });

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body, target);
    await expect(cityOf(target.id)).resolves.toBe('Krakow');
  });

  it('umac-11 Test 5 · contrast: a colleague PATCH of a visible, active target stays 403, row unchanged', async () => {
    const viewer = await fx.user('umac11-viewer');
    const target = await fx.user('umac11-visible-target', { city: 'Krakow' });

    const res = await patchUser(target.id, bearer(viewer.id), {
      city: 'Berlin',
    });

    expect(res.status).toBe(403);
    await expect(cityOf(target.id)).resolves.toBe('Krakow');
  });

  it('umac-11 Test 6 · 401 precedes 404 — unresolved or deactivated session on a missing target', async () => {
    const deactivated = await fx.user('umac11-deactivated-caller', {
      isActive: false,
    });
    const missingId = uuidv7();

    for (const authorization of [
      'Bearer <token:Bob>',
      bearer(deactivated.id),
    ]) {
      expect((await getUser(missingId, authorization)).status).toBe(401);
      expect(
        (await patchUser(missingId, authorization, { city: 'Berlin' })).status,
      ).toBe(401);
    }
  });
});
