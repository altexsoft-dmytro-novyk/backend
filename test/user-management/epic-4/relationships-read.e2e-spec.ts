import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  ORG_RELATIONSHIPS_WRITE_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectLeakFreeBody,
  type TestApp,
} from './fixtures';

/**
 * Story 6.1 (Epic 6) — `GET /users/:id/relationships` (read the current
 * reporting-line manager + People Partner). AD-1 Stage-2 suite.
 *
 * Spec: _bmad-output/implementation-artifacts/user-management/
 *   spec-6-1-read-current-manager-and-people-partner.md
 *
 * Lives in `test/user-management/epic-4/` on purpose — it sits with the other
 * `Relationship`-table suites (`manager-change`, `people-partner-change`, …) and
 * reuses their `fixtures.ts` (`fx.reportsTo` / `fx.peoplePartnerOf` /
 * `fx.grantFunctionalRole`). Verified red before implementation (the route did
 * not exist → every call 404'd, and the two no-session rows 404'd rather than
 * 401'd because route matching failed first); green after.
 *
 * Access gate (spec §Boundaries, Option B — Dmytro 2026-09-04): the viewer may
 * read iff `resolveAudiences(viewer, [target]) ∩ { reporting, pp } ≠ ∅` OR
 * `isAllowed(viewer, 'org:relationships:write')` ("edit implies read"). Denial
 * oracle (PM/AD-24 five-clause): `401` unresolved session; `404` leak-free when
 * `:id` is not an active `User`, decided BEFORE the gate; `403` leak-free when
 * the target is visible but the viewer is not entitled.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. Edges + users are seeded directly; the capability is
 * granted via a real FR-policy chain.
 */
describe('Story 6.1 (Epic 6) — GET /users/:id/relationships [lives with the epic-4 relationship suite]', () => {
  let testApp: TestApp;
  let fx: RunFixtures;
  const projectIds: string[] = [];

  const server = () => testApp.app.getHttpServer();

  const getRelationships = (subjectId: string, viewerId?: string) => {
    const req = request(server()).get(`/users/${subjectId}/relationships`);
    return viewerId ? req.set('authorization', bearer(viewerId)) : req;
  };

  interface EdgeView {
    relationshipId: string;
    type: string;
    target: { id: string; firstName: string; lastName: string };
  }

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await fx.cleanup();
    if (projectIds.length > 0) {
      await testApp.prisma.project.deleteMany({
        where: { id: { in: projectIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // Row 1 — Manager + PP both set --------------------------------------
  it('um-rel-18 · T1 · manager + PP both set, viewer is the reporting-line manager → 200 with both current edges, manager edge first', async () => {
    const target = await fx.user('rel-read-t1-target');
    const manager = await fx.user('rel-read-t1-manager', {
      firstName: 'Mona',
      lastName: 'Manager',
    });
    const partner = await fx.user('rel-read-t1-partner', {
      firstName: 'Pat',
      lastName: 'Partner',
    });
    await fx.reportsTo(target.id, manager.id);
    await fx.peoplePartnerOf(target.id, partner.id);

    const res = await getRelationships(target.id, manager.id);

    expect(res.status).toBe(200);
    const body = res.body as { data?: EdgeView[] } & Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['data']);
    expect(body).not.toHaveProperty('canEdit');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);

    // Explicit order guarantee (spec §Code Map / api-conventions): `direct`
    // (manager) edge before `people_partner`.
    expect(body.data?.[0]?.type).toBe('direct');
    expect(body.data?.[1]?.type).toBe('people_partner');

    const direct = body.data?.[0];
    expect(typeof direct?.relationshipId).toBe('string');
    expect(direct?.target).toEqual({
      id: manager.id,
      firstName: 'Mona',
      lastName: 'Manager',
    });

    const pp = body.data?.[1];
    expect(typeof pp?.relationshipId).toBe('string');
    expect(pp?.target).toEqual({
      id: partner.id,
      firstName: 'Pat',
      lastName: 'Partner',
    });

    // No closed / project edge, no extra keys on an edge.
    for (const edge of body.data ?? []) {
      expect(Object.keys(edge).sort()).toEqual(
        ['relationshipId', 'target', 'type'].sort(),
      );
      expect(['direct', 'people_partner']).toContain(edge.type);
    }
  });

  // Row 2 — PP only ---------------------------------------------------
  it('um-rel-19 · T2 · PP only, viewer is the assigned People Partner → 200 with just the people_partner edge', async () => {
    const target = await fx.user('rel-read-t2-target');
    const partner = await fx.user('rel-read-t2-partner', {
      firstName: 'Priya',
      lastName: 'Pole',
    });
    await fx.peoplePartnerOf(target.id, partner.id);

    const res = await getRelationships(target.id, partner.id);

    expect(res.status).toBe(200);
    const body = res.body as { data: EdgeView[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.type).toBe('people_partner');
    expect(body.data[0]?.target).toEqual({
      id: partner.id,
      firstName: 'Priya',
      lastName: 'Pole',
    });
  });

  // Row 3 — No edges -----------------------------------------------
  it('um-rel-20 · T3 · active target with no edges, entitled viewer → 200 { data: [] }, not 404', async () => {
    const target = await fx.user('rel-read-t3-target');
    const viewer = await fx.user('rel-read-t3-viewer');
    await fx.grantFunctionalRole(viewer.id, [
      ORG_RELATIONSHIPS_WRITE_PERMISSION,
    ]);

    const res = await getRelationships(target.id, viewer.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  // Row 4 — Visible but not entitled --------------------------------
  it('um-rel-21 · T4 · viewer resolves only colleague and holds no org:relationships:write → 403, leak-free', async () => {
    const target = await fx.user('rel-read-t4-target');
    const manager = await fx.user('rel-read-t4-manager');
    await fx.reportsTo(target.id, manager.id);
    const outsider = await fx.user('rel-read-t4-outsider');

    const res = await getRelationships(target.id, outsider.id);

    expect(res.status).toBe(403);
    expectLeakFreeBody(res.body, target);
    expect(JSON.stringify(res.body)).not.toContain('people_partner');
    expect(JSON.stringify(res.body)).not.toContain(manager.id);
  });

  it('um-rel-21 · T4b · Self is not a reader (only the self audience, no capability) → 403', async () => {
    const target = await fx.user('rel-read-t4b-target');
    const manager = await fx.user('rel-read-t4b-manager');
    await fx.reportsTo(target.id, manager.id);

    const res = await getRelationships(target.id, target.id);

    expect(res.status).toBe(403);
  });

  // Row 5 — Entitled by capability ---------------------------------
  it('um-rel-22 · T5 · viewer holds org:relationships:write but has no reporting/pp audience → 200 with the current edges', async () => {
    const target = await fx.user('rel-read-t5-target');
    const manager = await fx.user('rel-read-t5-manager', {
      firstName: 'Max',
      lastName: 'Boss',
    });
    await fx.reportsTo(target.id, manager.id);

    const hr = await fx.user('rel-read-t5-hr');
    await fx.grantFunctionalRole(hr.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);

    const res = await getRelationships(target.id, hr.id);

    expect(res.status).toBe(200);
    const body = res.body as { data: EdgeView[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.type).toBe('direct');
    expect(body.data[0]?.target).toEqual({
      id: manager.id,
      firstName: 'Max',
      lastName: 'Boss',
    });
  });

  // Row 6 — Target missing / inactive ------------------------------
  it('um-rel-23 · T6a · :id is not a known User → 404 leak-free, before any audience resolution', async () => {
    const viewer = await fx.user('rel-read-t6a-viewer');
    await fx.grantFunctionalRole(viewer.id, [
      ORG_RELATIONSHIPS_WRITE_PERMISSION,
    ]);

    const res = await getRelationships(uuidv7(), viewer.id);

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body);
  });

  it('um-rel-23 · T6b · :id is an inactive User → 404 leak-free', async () => {
    const inactive = await fx.user('rel-read-t6b-inactive', {
      isActive: false,
    });
    const viewer = await fx.user('rel-read-t6b-viewer');
    await fx.grantFunctionalRole(viewer.id, [
      ORG_RELATIONSHIPS_WRITE_PERMISSION,
    ]);

    const res = await getRelationships(inactive.id, viewer.id);

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body, inactive);
  });

  // Row 7 — No / unresolved session -------------------------------
  it('um-rel-24 · T7a · no Authorization header → 401', async () => {
    const target = await fx.user('rel-read-t7a-target');

    const res = await getRelationships(target.id);

    expect(res.status).toBe(401);
  });

  it('um-rel-24 · T7b · Bearer token resolving to nobody → 401', async () => {
    const target = await fx.user('rel-read-t7b-target');

    const res = await getRelationships(target.id, uuidv7());

    expect(res.status).toBe(401);
  });

  // Projection guards ------------------------------------------------
  it("um-rel-25 · T8 · a `type: 'project'` edge on the subject is never returned", async () => {
    const target = await fx.user('rel-read-t8-target');
    const manager = await fx.user('rel-read-t8-manager', {
      firstName: 'Meg',
      lastName: 'Manager',
    });
    await fx.reportsTo(target.id, manager.id);

    const project = await testApp.prisma.project.create({
      data: { name: `${fx.runId}-project` },
    });
    projectIds.push(project.id);
    await testApp.prisma.relationship.create({
      data: { userId: target.id, type: 'project', projectId: project.id },
    });

    const hr = await fx.user('rel-read-t8-hr');
    await fx.grantFunctionalRole(hr.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);

    const res = await getRelationships(target.id, hr.id);

    expect(res.status).toBe(200);
    const body = res.body as { data: EdgeView[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.type).toBe('direct');
    expect(body.data.some((e) => e.type === 'project')).toBe(false);
  });

  it('um-rel-26 · T9 · a `direct` edge whose target manager is deactivated is not a current edge', async () => {
    const target = await fx.user('rel-read-t9-target');
    const manager = await fx.user('rel-read-t9-manager');
    await fx.reportsTo(target.id, manager.id);
    // The manager leaves — the edge row survives (hard-delete model), but a
    // departed user is not who you currently report to.
    await testApp.prisma.user.update({
      where: { id: manager.id },
      data: { isActive: false },
    });

    const hr = await fx.user('rel-read-t9-hr');
    await fx.grantFunctionalRole(hr.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);

    const res = await getRelationships(target.id, hr.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });
});
