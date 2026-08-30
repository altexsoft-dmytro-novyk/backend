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
  createSeededUser,
  newRunId,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/profile/um-pf-01..03.md
// (um-pf-04, ttId uniqueness, is dead/uncited per the 2026-08-30 audit —
// docs/test-cases/user-management/README.md's Layout table — not
// translated here).
//
// Rewritten from scratch (2026-08-30 architecture-reset audit). The prior
// version of this file created its fixture users via POST /users (retired,
// spine AD-25 — seed/import only) and sent literal `Bearer <token:Persona>`
// placeholders that the real SessionAuthGuard now rejects outright. This
// suite seeds users/relationships directly via Prisma
// (../fixtures/seed-data.ts, the same pattern seed/auth already
// established) and signs real session tokens with the production
// signSessionToken (src/access-control/application/guards/session-token.ts)
// — the same authority SessionAuthGuard verifies against — rather than
// inventing a second token scheme.
describe('Profile edits — PATCH /users/:id, PUT /users/:id/photo (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('profile');
  let departmentId: string;

  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    const dept = await createDepartment(prisma, runId);
    departmentId = dept.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  describe('um-pf-01 · Manager-line edit to identity fields persists', () => {
    it('writes the new position/city, then a read reflects them', async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-pf01',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-pf01',
        departmentId,
        { position: 'Engineer', city: 'Warsaw' },
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      const res = await request(app.getHttpServer())
        .patch(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .send({ position: 'Senior Engineer', city: 'Krakow' })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.position).toBe('Senior Engineer');
      expect(body.city).toBe('Krakow');

      const read = await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .expect(200);

      // GET /users/:id nests S1 identity fields under `identity` (see
      // UsersController.getProfile) — only firstName/lastName/workEmail are
      // duplicated at the top level.
      const readBody = read.body as {
        identity: { position: string; city: string };
      };
      expect(readBody.identity.position).toBe('Senior Engineer');
      expect(readBody.identity.city).toBe('Krakow');
    });
  });

  describe('um-pf-02 · Self photo upload persists', () => {
    it('writes a new photo reference, then a read reflects it', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-pf02',
        departmentId,
        { photo: null },
      );

      const res = await request(app.getHttpServer())
        .put(`/users/${alice.id}/photo`)
        .set('authorization', bearer(alice.id))
        .attach('photo', Buffer.from('fake-jpeg-bytes'), 'alice.jpg')
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.photoUrl).toBeDefined();
      expect(body.photoUrl).not.toBeNull();

      const read = await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(alice.id))
        .expect(200);

      const readBody = read.body as { identity: { photo: string } };
      expect(readBody.identity.photo).toBe(body.photoUrl);
    });
  });

  describe('um-pf-03 · editing workEmail to an address already in use is rejected', () => {
    it('rejects with 409 and leaves workEmail unchanged', async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-pf03',
        departmentId,
      );
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-pf03',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-pf03',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      await request(app.getHttpServer())
        .patch(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .send({ workEmail: colin.workEmail })
        .expect(409);

      const read = await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.workEmail).toBe(alice.workEmail);
      expect(readBody.workEmail).not.toBe(colin.workEmail);
    });
  });
});
