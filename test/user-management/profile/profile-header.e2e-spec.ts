import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import {
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createPPEdge,
  createSeededUser,
  newRunId,
} from '../fixtures/seed-data';

// B3 — GET /api/v1/users/:id now carries the §4.2 profile-header relations:
// department (always present), manager (`Relationship type='direct'`) and
// people partner (`type='people_partner'`), each resolved to a display name;
// mentor when the viewer can see S13. These ride along with S1 (readable by
// every audience incl. colleague), so they add no leak surface.
describe('Profile header relations — GET /users/:id (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('pf-header');
  let departmentId: string;
  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;

  interface ProfileBody {
    department: { id: string; name: string } | null;
    manager: { id: string; name: string } | null;
    peoplePartner: { id: string; name: string } | null;
    mentor: { id: string; name: string } | null;
    openToMentoring?: boolean;
    mentorship?: unknown;
    projects: unknown[];
  }

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    departmentId = (
      await createDepartment(prisma, runId, { name: `${runId}-Engineering` })
    ).id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('exposes department, manager and people partner by name to a manager-line viewer', async () => {
    const bob = await createSeededUser(prisma, runId, 'Bob', departmentId);
    const paula = await createSeededUser(prisma, runId, 'Paula', departmentId);
    const alice = await createSeededUser(prisma, runId, 'Alice', departmentId);
    await createDirectEdge(prisma, alice.id, bob.id);
    await createPPEdge(prisma, alice.id, paula.id);

    const res = await request(app.getHttpServer())
      .get(`/users/${alice.id}`)
      .set('authorization', bearer(bob.id))
      .expect(200);

    const body = res.body as ProfileBody;
    expect(body.department).toEqual({
      id: departmentId,
      name: `${runId}-Engineering`,
    });
    expect(body.manager).toEqual({
      id: bob.id,
      name: `${bob.firstName} ${bob.lastName}`,
    });
    expect(body.peoplePartner).toEqual({
      id: paula.id,
      name: `${paula.firstName} ${paula.lastName}`,
    });
    expect(body.mentor).toBeNull();
  });

  it('returns null manager/people partner/mentor when none are assigned', async () => {
    const alice = await createSeededUser(prisma, runId, 'Solo', departmentId);

    const res = await request(app.getHttpServer())
      .get(`/users/${alice.id}`)
      .set('authorization', bearer(alice.id))
      .expect(200);

    const body = res.body as ProfileBody;
    expect(body.department).toEqual({
      id: departmentId,
      name: `${runId}-Engineering`,
    });
    expect(body.manager).toBeNull();
    expect(body.peoplePartner).toBeNull();
    expect(body.mentor).toBeNull();
  });

  it('carries the viewer-specific section access map (§3.3.5)', async () => {
    const bob = await createSeededUser(prisma, runId, 'BobAcc', departmentId);
    const stranger = await createSeededUser(
      prisma,
      runId,
      'StrangerAcc',
      departmentId,
    );
    const alice = await createSeededUser(
      prisma,
      runId,
      'AliceAcc',
      departmentId,
    );
    await createDirectEdge(prisma, alice.id, bob.id);

    const accessFor = async (viewerId: string) => {
      const res = await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(viewerId))
        .expect(200);
      return (res.body as { access: Record<string, string> }).access;
    };

    // Self: S1 read, S2 write, S6 none (matrix §3.2).
    const selfAccess = await accessFor(alice.id);
    expect(selfAccess.s1).toBe('read');
    expect(selfAccess.s2).toBe('write');
    expect(selfAccess.s6).toBe('none');

    // Reporting line: S1/S6 write, S2 read.
    const mgrAccess = await accessFor(bob.id);
    expect(mgrAccess.s1).toBe('write');
    expect(mgrAccess.s6).toBe('write');
    expect(mgrAccess.s2).toBe('read');

    // Colleague: S1 read only, everything management-only is none.
    const colAccess = await accessFor(stranger.id);
    expect(colAccess.s1).toBe('read');
    expect(colAccess.s2).toBe('none');
    expect(colAccess.s6).toBe('none');
  });

  it('a colleague viewer still sees the header relations (S1 is R for colleague) but no — section', async () => {
    const bob = await createSeededUser(prisma, runId, 'Bob2', departmentId);
    const stranger = await createSeededUser(
      prisma,
      runId,
      'Stranger',
      departmentId,
    );
    const alice = await createSeededUser(prisma, runId, 'Alice2', departmentId);
    await createDirectEdge(prisma, alice.id, bob.id);

    const res = await request(app.getHttpServer())
      .get(`/users/${alice.id}`)
      .set('authorization', bearer(stranger.id))
      .expect(200);

    const body = res.body as ProfileBody;
    expect(body.manager).toEqual({
      id: bob.id,
      name: `${bob.firstName} ${bob.lastName}`,
    });
    // Colleague whitelist: S13 mentorship is not projected at all.
    expect(body.openToMentoring).toBeUndefined();
    expect(body.mentorship).toBeUndefined();
    // Colleague sees only project names, not ids (existing contract).
    expect(Array.isArray(body.projects)).toBe(true);
  });
});
