import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { NodemailerMagicLinkMailer } from '../../../src/user-management/infrastructure/nodemailer-magic-link-mailer.adapter';
import { bootstrapApp } from '../fixtures/app';
import { RecordingMagicLinkMailer } from '../fixtures/fake-mailer';
import { hashToken } from '../fixtures/magic-link';
import {
  mintExpiredMagicLinkToken,
  mintMagicLinkToken,
} from '../fixtures/magic-link';
import {
  cleanupRun,
  createDepartment,
  createSeededUser,
  deactivateUser,
  newRunId,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/auth/um-auth-01..06.md
//
// Rewritten from scratch (2026-08-30 architecture-reset audit;
// docs/test-cases/user-management/README.md's Layout table marks auth/ as
// "alive"). Moved from test/user-management/auth.e2e-spec.ts (flat) to
// this nested test/user-management/auth/ location to match the repo's
// established per-bounded-context nesting convention (CLAUDE.md: "e2e
// specs for a bounded context live under test/<context-name>/"; already
// followed by test/access-control/auth/auth.e2e-spec.ts).
//
// The prior version of this file created its fixture users via
// POST /users and consumed a literal `<magic-link-token:...>` placeholder.
// Both diverge from the current contract: POST /users is retired (spine
// AD-25 — no product create-path; seed/import only, Story 1.1), and Epic 2
// IS the magic-link flow itself, so a placeholder token has a real
// HTTP-observable seam now (POST /auth/magic-link/consume) instead of
// needing one. This suite seeds users directly via Prisma
// (../fixtures/seed-data.ts) and mints real, hashed-at-rest tokens
// (../fixtures/magic-link.ts) that the real consume endpoint is expected
// to accept once implemented.
describe('Magic-link authentication — POST /auth/magic-link(/consume) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailer: RecordingMagicLinkMailer;
  const runId = newRunId('auth');
  let departmentId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp((builder) =>
      builder
        .overrideProvider(NodemailerMagicLinkMailer)
        .useClass(RecordingMagicLinkMailer),
    );
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    mailer = bootstrapped.moduleRef.get(NodemailerMagicLinkMailer);
    const dept = await createDepartment(prisma, runId);
    departmentId = dept.id;
  });

  beforeEach(() => {
    mailer.reset();
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  describe('um-auth-01 · request a magic link for a registered email', () => {
    it('accepts the request and confirms dispatch with no sensitive data', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-auth01',
        departmentId,
      );

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: alice.workEmail })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
      expect(Object.keys(body)).not.toEqual(
        expect.arrayContaining(['token', 'password']),
      );

      // B1: exactly one sign-in email is delivered, to Alice, carrying a raw
      // token that hashes to a freshly minted, unconsumed MagicLinkToken row.
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].workEmail).toBe(alice.workEmail);
      const tokenRow = await prisma.magicLinkToken.findUnique({
        where: { tokenHash: hashToken(mailer.sent[0].rawToken) },
      });
      expect(tokenRow).not.toBeNull();
      expect(tokenRow?.userId).toBe(alice.id);
      expect(tokenRow?.consumedAt).toBeNull();
      expect(tokenRow?.dispatchStatus).toBe('sent');
    });
  });

  describe('um-auth-02 · request a magic link for an unregistered email', () => {
    it('responds identically to um-auth-01, revealing nothing about account existence', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: `${runId}-nobody@company.example` })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
      // B1: no email is dispatched for an address with no account.
      expect(mailer.sent).toHaveLength(0);
      // No email-adapter DI seam exists yet to assert "zero dispatch"
      // against directly (same gap the retired registration.e2e-spec.ts's
      // um-reg-13 comment documented) — and there is no User/MagicLinkToken
      // row to check either, since no account exists for this address at
      // all. um-auth-06 Test 1 below adds a DB-observable proxy (zero
      // MagicLinkToken rows minted) for the deactivated case, where a real
      // account id does exist to query against.
    });
  });

  describe('um-auth-01b · a mail transport failure never fails the request', () => {
    it('still returns 200 { sent: true } and records dispatchStatus=failed (NFR-3)', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-auth01b',
        departmentId,
      );
      mailer.nextResult = 'failed';

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: alice.workEmail })
        .expect(200);

      expect((res.body as Record<string, unknown>).sent).toBe(true);
      expect(mailer.sent).toHaveLength(1);
      const tokenRow = await prisma.magicLinkToken.findUnique({
        where: { tokenHash: hashToken(mailer.sent[0].rawToken) },
      });
      expect(tokenRow?.dispatchStatus).toBe('failed');
    });
  });

  describe('um-auth-03 · consuming a valid magic-link token establishes a session', () => {
    it('returns a session token usable for a follow-up authenticated request', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-auth03',
        departmentId,
      );
      const { raw } = await mintMagicLinkToken(prisma, alice.id);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: raw })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      const sessionToken = body.accessToken ?? body.sessionToken ?? body.token;
      expect(sessionToken).toBeDefined();

      await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', `Bearer ${String(sessionToken)}`)
        .expect(200);
    });
  });

  describe('um-auth-04 · consuming an expired magic-link token is denied', () => {
    it('rejects with 401 and no session token', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-auth04',
        departmentId,
      );
      const { raw } = await mintExpiredMagicLinkToken(prisma, alice.id);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: raw })
        .expect(401);

      const body = res.body as Record<string, unknown>;
      expect(
        body.accessToken ?? body.sessionToken ?? body.token,
      ).toBeUndefined();
    });
  });

  describe('um-auth-05 · a magic-link token cannot be consumed twice', () => {
    it('accepts the first consumption and denies the replay', async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-auth05',
        departmentId,
      );
      const { raw } = await mintMagicLinkToken(prisma, alice.id);

      await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: raw })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: raw })
        .expect(401);

      const body = res.body as Record<string, unknown>;
      expect(
        body.accessToken ?? body.sessionToken ?? body.token,
      ).toBeUndefined();
    });
  });

  describe('um-auth-06 · deactivated user cannot establish a session via magic link', () => {
    it('Test 1 — request is enumeration-safe (DEC-UM-012, draft/PO-pending): 200, same shape, zero token minted', async () => {
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-auth06-req',
        departmentId,
      );
      await deactivateUser(prisma, colin.id);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: colin.workEmail })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
      expect(Object.keys(body)).not.toEqual(
        expect.arrayContaining(['token', 'password']),
      );
      // Proxy for "zero email dispatch" (no email-adapter fake seam exists
      // yet, see um-auth-02's note): a deactivated address must not even
      // get a MagicLinkToken row minted, per DEC-UM-012 treating it exactly
      // like an unknown address — DEC-UM-012 is proposed/draft pending PO
      // confirmation (spine AD-22 note), applied here per this task's
      // instruction to test it while flagging it as unconfirmed.
      const tokens = await prisma.magicLinkToken.findMany({
        where: { userId: colin.id },
      });
      expect(tokens).toHaveLength(0);
      // B1: and no email is delivered either.
      expect(mailer.sent).toHaveLength(0);
    });

    it('Test 2 — a pre-deactivation token must not yield a session', async () => {
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-auth06-consume',
        departmentId,
      );
      const { raw } = await mintMagicLinkToken(prisma, colin.id);
      await deactivateUser(prisma, colin.id);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: raw })
        .expect(401);

      const body = res.body as Record<string, unknown>;
      expect(
        body.accessToken ?? body.sessionToken ?? body.token,
      ).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});
