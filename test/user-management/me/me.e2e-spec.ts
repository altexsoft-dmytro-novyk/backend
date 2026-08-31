import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { bootstrapApp } from '../fixtures/app';
import {
  attachPolicyToUser,
  cleanupRun,
  createDepartment,
  createSeededUser,
  ensurePolicyWithPermission,
  markDismissed,
  newRunId,
} from '../fixtures/seed-data';

// B2 — GET /api/v1/me: the signed-in user's identity + the closed set of
// §2.3 named feature permissions they hold, resolved live through the same
// AccessControl facade the mutating routes gate on. The frontend keys UI
// affordances off this so it never shows a control the user can't use.
describe('Session identity & capabilities — GET /me (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('me');
  let departmentId: string;
  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    departmentId = (await createDepartment(prisma, runId)).id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('401 without a bearer token', async () => {
    await request(app.getHttpServer()).get('/me').expect(401);
  });

  it('returns identity fields and an empty permission set for an ordinary employee', async () => {
    const user = await createSeededUser(prisma, runId, 'plain', departmentId);

    const res = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', bearer(user.id))
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.id).toBe(user.id);
    expect(body.firstName).toBe(user.firstName);
    expect(body.workEmail).toBe(user.workEmail);
    expect(body.employmentStatus).toBe('active');
    expect(body.permissions).toEqual([]);
  });

  it('reports exactly the named permissions attached via policy', async () => {
    const user = await createSeededUser(prisma, runId, 'partial', departmentId);
    const policy = await ensurePolicyWithPermission(
      prisma,
      `${runId}-departures`,
      'record a departure',
    );
    await attachPolicyToUser(prisma, user.id, policy.id);

    const res = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', bearer(user.id))
      .expect(200);

    expect((res.body as Record<string, unknown>).permissions).toEqual([
      'record a departure',
    ]);
  });

  it('reports manage_roles for a roles-admin and reflects a dismissed status', async () => {
    const user = await createSeededUser(prisma, runId, 'admin', departmentId);
    const policy = await ensurePolicyWithPermission(
      prisma,
      `${runId}-roles`,
      'manage_roles',
    );
    await attachPolicyToUser(prisma, user.id, policy.id);
    await markDismissed(prisma, user.id);

    const res = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', bearer(user.id))
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.permissions).toEqual(['manage_roles']);
    expect(body.employmentStatus).toBe('dismissed');
  });
});
