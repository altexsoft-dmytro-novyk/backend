import 'dotenv/config';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { OBJECT_STORAGE_PORT } from '../../../src/storage/domain/interfaces/object-storage.port';
import {
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
} from './fixtures';

/**
 * Epic 1 — Story 1.3 (Self Uploads Own Photo) · AD-1 Stage 2 · committed-red
 * real-consumer HTTP E2E. One `it()` per approved Stage-1 scenario
 * (`docs/test-cases/user-management/profile/um-photo-01..09.md` + that folder's
 * `README.md` — the acceptance criteria; scenario id in every test title).
 *
 * ── AD-3 / AD-15: real everything, no provider override ─────────────────────
 * Real `AppModule`, real Prisma against migrated PostgreSQL, and the REAL
 * `src/storage/` stack — `OBJECT_STORAGE_PORT` → `S3StorageAdapter` → LocalStack
 * S3 (compose stack, `AWS_ENDPOINT_URL`). No `overrideProvider` anywhere; in
 * particular NOTHING is faked at `OBJECT_STORAGE_PORT` (`um-photo-08` gate).
 * `db:up` / `docker compose up` brings LocalStack up alongside Postgres; if it
 * is down, the real-storage scenarios are red on environment setup and Story
 * 1.3 is not done (they must never degrade to a fake).
 *
 * DEC-UM-010: one worker (`--runInBand`), run-namespaced rows, wrapped teardown
 * (all via `RunFixtures`).
 *
 * ── WHY RED (state of the interim handler today) ───────────────────────────
 * `users.controller.ts` `@Put(':id/photo')` still carries
 * `@RequireFeatureForTarget('user-management:upload-photo')`. That key is
 * unseeded AND `AccessControlFacadeAdapter.isAllowedForTarget` fails closed for
 * every non-`user-management:read` feature — so `AccessControlGuard` throws
 * `403` for EVERY caller, Self included, before the `FileInterceptor`, the
 * `!file` check, or the storage call is ever reached. There is no size/MIME/
 * empty validation and no `503` storage-failure path.
 *
 * Every scenario that expects `200` / `400` / `503` is therefore committed-red
 * on that blanket `403` and goes green only once Stage 3:
 *   - drops the `upload-photo` feature gate and rebinds the route to the
 *     Self-only identity check (`viewer id === target id`), mirroring `umac-09`;
 *   - adds the `FileInterceptor` `limits.fileSize` (5 MiB) + MIME allow-list
 *     (`image/jpeg` | `image/png` | `image/webp`) + zero-byte rejection → `400`;
 *   - maps a real object-store connection failure to `503`, ordered object
 *     first then row so `User.photo` never half-applies.
 *
 * Scenarios that already assert `401` / `403` (`um-photo-03`, `-04`, `-05`) pass
 * TODAY — noted per describe as GREEN-under-interim; they are kept as real
 * `it()`s so the Stage-3 rebind cannot regress the denial semantics, and
 * `um-photo-04 Test 3` / `um-photo-05` additionally pin the interim-vs-target
 * disposition split.
 *
 * `um-photo-07` (storage outage → `503`) is exercised for real by booting a
 * SECOND `AppModule` with `AWS_ENDPOINT_URL` pointed at a closed port — the real
 * `S3StorageAdapter` against a real connection fault, NOT a port fake / provider
 * override (see that describe's note). `um-photo-06 Test 5` (magic-byte sniff)
 * is `it.todo` — a flagged, optional defense-in-depth implementer choice
 * (README decision 4).
 */

// ── Minimal valid image payloads (real magic bytes, tiny) ──────────────────
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
);
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBP_1x1 = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  'base64',
);
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0)]);
// > 5 MiB, still with a real JPEG header so only the size rule is under test.
const OVERSIZE_JPEG = Buffer.concat([
  JPEG_1x1,
  Buffer.alloc(5 * 1024 * 1024 + 1024, 0),
]);

// ── Out-of-band S3 (real bucket reads — there is no app route for stored bytes)
const S3_BUCKET = process.env.AWS_S3_BUCKET ?? 'user-management-photos';
const S3_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const S3_REGION = process.env.AWS_REGION ?? 'us-east-1';

const s3 = (): S3Client =>
  new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

/** `http://host/<bucket>/photos/<id>/<uuid>` → `{ bucket, key }` (path-style). */
function parsePhotoRef(ref: string): { bucket: string; key: string } {
  const { pathname } = new URL(ref);
  const parts = pathname.replace(/^\/+/, '').split('/');
  return { bucket: parts[0], key: parts.slice(1).join('/') };
}

async function getObject(
  bucket: string,
  key: string,
): Promise<{ bytes: Buffer; contentType?: string; contentLength?: number }> {
  const out = await s3().send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!out.Body) throw new Error('S3 GetObject returned no body');
  const arr = await out.Body.transformToByteArray();
  return {
    bytes: Buffer.from(arr),
    contentType: out.ContentType,
    contentLength: out.ContentLength,
  };
}

/** Keys currently under `photos/<userId>/` in the real bucket. */
async function listPhotoKeys(userId: string): Promise<string[]> {
  const out = await s3().send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `photos/${userId}/`,
    }),
  );
  return (out.Contents ?? []).map((o) => o.Key ?? '');
}

interface UserResponseBody {
  photo?: unknown;
  firstName?: unknown;
  [k: string]: unknown;
}
interface CardEnvelope {
  data: Record<string, unknown>;
  canEdit: boolean;
}

describe('Epic 1 · Story 1.3 — Self Uploads Own Photo · PUT /users/:id/photo (e2e)', () => {
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

  const server = (): App => testApp.app.getHttpServer();

  const putPhoto = (
    targetId: string,
    auth: string | undefined,
    file: { buffer: Buffer; filename: string; contentType: string } | null,
    extraFields: Record<string, string> = {},
  ) => {
    let req = request(server()).put(`/users/${targetId}/photo`);
    if (auth !== undefined) req = req.set('authorization', auth);
    for (const [name, value] of Object.entries(extraFields)) {
      req = req.field(name, value);
    }
    if (file) {
      req = req.attach('photo', file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });
    }
    return req;
  };

  const jpeg = (filename = 'alice.jpg') => ({
    buffer: JPEG_1x1,
    filename,
    contentType: 'image/jpeg',
  });
  const png = (filename = 'alice.png') => ({
    buffer: PNG_1x1,
    filename,
    contentType: 'image/png',
  });
  const webp = (filename = 'alice.webp') => ({
    buffer: WEBP_1x1,
    filename,
    contentType: 'image/webp',
  });

  const getCard = (targetId: string, viewerId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  const rowPhoto = async (id: string): Promise<string | null> => {
    const row = await testApp.prisma.user.findUnique({
      where: { id },
      select: { photo: true },
    });
    return row?.photo ?? null;
  };

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-01 · Self first upload → 200, photo persists, visible on read
  // RED today: blanket 403 from the unseeded upload-photo gate.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-01 · Self uploads a first photo — it persists and reflects on a read [RED]', () => {
    it('PUT .../photo → 200 non-null photo ref; follow-up GET shows it at data.photo', async () => {
      const alice = await fx.user('photo01-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const write = await putPhoto(alice.id, bearer(alice.id), jpeg());
      expect(write.status).toBe(200);
      const body = write.body as UserResponseBody;
      // Plain `toUserResponse` shape (README decision 9), not the { data, canEdit }
      // envelope.
      expect(typeof body.photo).toBe('string');
      expect(body.photo).not.toBeNull();
      const photoRef = body.photo as string;
      expect(photoRef).not.toBe('alice.jpg');
      expect(photoRef).toContain(`photos/${alice.id}/`);

      const read = await getCard(alice.id, alice.id);
      expect(read.status).toBe(200);
      const card = read.body as CardEnvelope;
      expect(card.data.photo).toBe(photoRef);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-02 · Self replace → new immutable key, old object orphaned
  // RED today: blanket 403.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-02 · Self replaces an existing photo — full-replace semantics [RED]', () => {
    it('second PUT → 200 with a NEW photo ref (!== first); GET reflects the new one; old object not deleted synchronously', async () => {
      const alice = await fx.user('photo02-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const first = await putPhoto(
        alice.id,
        bearer(alice.id),
        png('first.png'),
      );
      expect(first.status).toBe(200);
      const photoRef1 = (first.body as UserResponseBody).photo as string;
      expect(typeof photoRef1).toBe('string');

      // A different valid type on replace — also covers `image/webp` in the
      // Stage-3 MIME allow-list.
      const second = await putPhoto(
        alice.id,
        bearer(alice.id),
        webp('second.webp'),
      );
      expect(second.status).toBe(200);
      const photoRef2 = (second.body as UserResponseBody).photo as string;
      expect(typeof photoRef2).toBe('string');
      expect(photoRef2).not.toBe(photoRef1);

      const read = await getCard(alice.id, alice.id);
      expect(read.status).toBe(200);
      expect((read.body as CardEnvelope).data.photo).toBe(photoRef2);

      // The new object is retrievable. The old one is left as a harmless orphan
      // (README decision 8 — no synchronous compensation, no `delete` verb).
      // We assert the row re-pointed; we do NOT assert photoRef1's object is gone.
      const { key } = parsePhotoRef(photoRef2);
      const keys = await listPhotoKeys(alice.id);
      expect(keys).toContain(key);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-03 · Self-only — manager / colleague / PP each 403
  // GREEN under interim (blanket 403), but for the wrong reason (permission,
  // not identity). Kept real so the Stage-3 identity rebind keeps denying.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-03 · photo upload is Self-only — a manager, a colleague and a PP are denied [GREEN-under-interim]', () => {
    it('Bob (reporting-line manager) → 403; Alice.photo unchanged; nothing stored', async () => {
      const bob = await fx.user('photo03-bob', { firstName: 'Bob' });
      const alice = await fx.user('photo03-alice', {
        firstName: 'Alice',
        photo: null,
      });
      // Real `direct` edge Alice→Bob so Bob genuinely holds reporting-line S1
      // write over Alice (umac-07 dual gate) — the photo rule is still narrower.
      await fx.reportsTo(alice.id, bob.id);

      const res = await putPhoto(
        alice.id,
        bearer(bob.id),
        jpeg('bob-tries.jpg'),
      );
      expect(res.status).toBe(403);
      expect(await rowPhoto(alice.id)).toBeNull();
      expect(await listPhotoKeys(alice.id)).toHaveLength(0);
    });

    it('Eve (unrelated colleague) → 403; Alice.photo unchanged', async () => {
      const eve = await fx.user('photo03-eve', { firstName: 'Eve' });
      const alice = await fx.user('photo03b-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const res = await putPhoto(
        alice.id,
        bearer(eve.id),
        jpeg('eve-tries.jpg'),
      );
      expect(res.status).toBe(403);
      expect(await rowPhoto(alice.id)).toBeNull();
    });

    it('Paula (assigned People Partner) → 403; Alice.photo unchanged', async () => {
      const paula = await fx.user('photo03-paula', { firstName: 'Paula' });
      const alice = await fx.user('photo03c-alice', {
        firstName: 'Alice',
        photo: null,
      });
      await fx.peoplePartnerOf(alice.id, paula.id);

      const res = await putPhoto(
        alice.id,
        bearer(paula.id),
        jpeg('paula-tries.jpg'),
      );
      expect(res.status).toBe(403);
      expect(await rowPhoto(alice.id)).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-04 · no / malformed / unresolved token
  // Test 1-2 → 401 (session layer), GREEN today.
  // Test 3 → target end state 401 (Epic 2); 403 under the interim resolver.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-04 · photo upload without a usable session [GREEN-under-interim]', () => {
    it('no Authorization header → 401; nothing stored; User.photo unchanged', async () => {
      const alice = await fx.user('photo04-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const res = await putPhoto(alice.id, undefined, jpeg('x.jpg'));
      expect(res.status).toBe(401);
      expect(await rowPhoto(alice.id)).toBeNull();
    });

    it('malformed bearer token → 401; nothing stored', async () => {
      const alice = await fx.user('photo04b-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const res = await putPhoto(
        alice.id,
        'Bearer not-a-real-token',
        jpeg('x.jpg'),
      );
      expect(res.status).toBe(401);
      expect(await rowPhoto(alice.id)).toBeNull();
    });

    it('valid-shape token, unresolved principal → 403 under the interim resolver (target end state 401, Epic 2)', async () => {
      const alice = await fx.user('photo04c-alice', {
        firstName: 'Alice',
        photo: null,
      });
      // The token parses to `{ userId: <uuid> }`; the Self identity check
      // `userId === alice.id` is false → 403 today. Post-Epic-2 the magic-link
      // middleware rejects the unresolved principal at the session layer → 401.
      const res = await putPhoto(alice.id, bearer(uuidv7()), jpeg('x.jpg'));
      expect([401, 403]).toContain(res.status);
      expect(res.status).toBe(403); // interim-resolver disposition, pinned
      expect(await rowPhoto(alice.id)).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-05 · Self upload against a non-resolvable / inactive target → 403
  // GREEN today (blanket 403); the target end state is also 403 (Self-only:
  // viewer id != target id), no 404, no existence signal.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-05 · Self upload against a non-resolvable target → 403 (no 404) [GREEN]', () => {
    it('target UUID matches no User row → 403, leak-free; nothing stored', async () => {
      const alice = await fx.user('photo05-alice', {
        firstName: 'Alice',
        photo: null,
      });
      const ghostId = uuidv7();

      const res = await putPhoto(ghostId, bearer(alice.id), jpeg('x.jpg'));
      expect(res.status).toBe(403);
      const body = res.body as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('not found');
      expect(await listPhotoKeys(ghostId)).toHaveLength(0);
    });

    it('target is an inactive User → 403; that row.photo unchanged; nothing stored', async () => {
      const alice = await fx.user('photo05b-alice', {
        firstName: 'Alice',
        photo: null,
      });
      const nina = await fx.user('photo05-nina', {
        firstName: 'Nina',
        photo: null,
        isActive: false,
      });

      const res = await putPhoto(nina.id, bearer(alice.id), jpeg('x.jpg'));
      expect(res.status).toBe(403);
      expect(await rowPhoto(nina.id)).toBeNull();
      expect(await listPhotoKeys(nina.id)).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-06 · input validation → 400 (nothing stored, photo unchanged)
  // RED today: Self hits the blanket 403 before any validation runs.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-06 · photo upload input validation → 400 [RED]', () => {
    let aliceId: string;

    beforeEach(async () => {
      const alice = await fx.user('photo06-alice', {
        firstName: 'Alice',
        photo: null,
      });
      aliceId = alice.id;
    });

    it('Test 1 — disallowed content type (application/pdf) → 400; nothing stored', async () => {
      const res = await putPhoto(aliceId, bearer(aliceId), {
        buffer: PDF_BYTES,
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      });
      expect(res.status).toBe(400);
      expect(await rowPhoto(aliceId)).toBeNull();
      expect(await listPhotoKeys(aliceId)).toHaveLength(0);
    });

    it('Test 1b — disallowed content type (image/gif) → 400; nothing stored', async () => {
      const res = await putPhoto(aliceId, bearer(aliceId), {
        buffer: GIF_BYTES,
        filename: 'anim.gif',
        contentType: 'image/gif',
      });
      expect(res.status).toBe(400);
      expect(await rowPhoto(aliceId)).toBeNull();
    });

    it('Test 2 — oversized file (> 5 MiB) → 400 (413 accepted equivalent); nothing stored', async () => {
      const res = await putPhoto(aliceId, bearer(aliceId), {
        buffer: OVERSIZE_JPEG,
        filename: 'big.jpg',
        contentType: 'image/jpeg',
      });
      expect([400, 413]).toContain(res.status);
      expect(await rowPhoto(aliceId)).toBeNull();
    });

    it('Test 3 — missing photo part (only a text field) → 400', async () => {
      const res = await putPhoto(aliceId, bearer(aliceId), null, {
        note: 'hello',
      });
      expect(res.status).toBe(400);
      expect(await rowPhoto(aliceId)).toBeNull();
    });

    it('Test 4 — zero-byte photo part → 400; nothing stored', async () => {
      const res = await putPhoto(aliceId, bearer(aliceId), {
        buffer: Buffer.alloc(0),
        filename: 'empty.png',
        contentType: 'image/png',
      });
      expect(res.status).toBe(400);
      expect(await rowPhoto(aliceId)).toBeNull();
      expect(await listPhotoKeys(aliceId)).toHaveLength(0);
    });

    // README decision 4 — a magic-byte sniff of the buffer is RECOMMENDED
    // defense-in-depth, not required. Left as an explicit implementer choice.
    it.todo(
      'Test 5 — content-type spoof (PDF bytes declared image/png) → 400 IFF a magic-byte sniff is implemented (open decision)',
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-07 · object store unreachable → 503, User.photo NOT changed
  //
  // Real adapter, real fault — NOT a port fake / provider override. A second
  // `AppModule` is booted with `AWS_ENDPOINT_URL` pointed at a closed port, so
  // the real `S3Client.send(PutObjectCommand)` throws a connection error,
  // exactly as the scenario's "How the failure is injected" paragraph
  // prescribes. RED today: the blanket 403 fires before storage is touched.
  // Goes green when Stage 3 (a) rebinds to the Self-only check and (b) maps the
  // storage connection failure to 503 with object-first-then-row ordering.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-07 · object store unreachable → 503, no half-apply [RED]', () => {
    const DEAD_ENDPOINT = 'http://127.0.0.1:59321'; // nothing listening
    let deadApp: INestApplication<App>;
    let deadModule: TestingModule;
    let deadPrisma: PrismaService;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      savedEnv.AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;
      savedEnv.AWS_MAX_ATTEMPTS = process.env.AWS_MAX_ATTEMPTS;
      process.env.AWS_ENDPOINT_URL = DEAD_ENDPOINT;
      process.env.AWS_MAX_ATTEMPTS = '1';

      deadModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      deadApp = deadModule.createNestApplication();
      deadApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      await deadApp.init();
      deadPrisma = deadApp.get(PrismaService);
    });

    afterAll(async () => {
      await deadApp.close();
      await deadModule.close();
      for (const key of ['AWS_ENDPOINT_URL', 'AWS_MAX_ATTEMPTS'] as const) {
        const original = savedEnv[key];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    });

    const deadServer = (): App => deadApp.getHttpServer();

    it('upload during the outage → 503; User.photo stays null; a retry (against the live store) then succeeds', async () => {
      const alice = await fx.user('photo07-alice', {
        firstName: 'Alice',
        photo: null,
      });

      // Test 1 — baseline: store up (for the live app), photo unset.
      const baseline = await getCard(alice.id, alice.id);
      expect(baseline.status).toBe(200);
      expect((baseline.body as CardEnvelope).data.photo).toBeNull();

      // Test 2 — upload against the dead-endpoint app.
      const outage = await request(deadServer())
        .put(`/users/${alice.id}/photo`)
        .set('authorization', bearer(alice.id))
        .attach('photo', JPEG_1x1, {
          filename: 'alice.jpg',
          contentType: 'image/jpeg',
        });
      expect(outage.status).toBe(503);

      // Test 3 — the row did not move.
      const afterRow = await deadPrisma.user.findUnique({
        where: { id: alice.id },
        select: { photo: true },
      });
      expect(afterRow?.photo ?? null).toBeNull();

      // Test 4 — retry against the live store (the primary app) succeeds.
      const retry = await putPhoto(alice.id, bearer(alice.id), jpeg());
      expect(retry.status).toBe(200);
      expect((retry.body as UserResponseBody).photo).toEqual(
        expect.any(String),
      );
      const read = await getCard(alice.id, alice.id);
      expect((read.body as CardEnvelope).data.photo).toEqual(
        expect.any(String),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-08 · the upload hits real object storage (AD-15 gate)
  // RED today: blanket 403 → no object is ever written to assert against.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-08 · the upload hits real object storage — Stage-2 bucket assertion (AD-15) [RED]', () => {
    it('after a Self upload the object exists in the real bucket and is byte-identical to the uploaded file', async () => {
      const alice = await fx.user('photo08-alice', {
        firstName: 'Alice',
        photo: null,
      });

      const write = await putPhoto(alice.id, bearer(alice.id), jpeg());
      expect(write.status).toBe(200);
      const photoRef = (write.body as UserResponseBody).photo as string;
      expect(typeof photoRef).toBe('string');

      const { bucket, key } = parsePhotoRef(photoRef);
      expect(key).toMatch(new RegExp(`^photos/${alice.id}/`));

      const obj = await getObject(bucket, key);
      expect(obj.contentType).toBe('image/jpeg');
      expect(obj.contentLength).toBe(JPEG_1x1.length);
      expect(obj.bytes.equals(JPEG_1x1)).toBe(true);
    });

    it('AD-15 gate — OBJECT_STORAGE_PORT resolves to the production S3StorageAdapter, no Fake/Mock/Stub bound', () => {
      // Asserted by construction: this suite boots the real AppModule with the
      // real @Global StorageModule and performs NO overrideProvider. If a
      // Fake*/Mock*/Stub* is ever bound at OBJECT_STORAGE_PORT, the byte-identity
      // assertion above stops hitting a real bucket and this whole file must be
      // treated as failing the AD-15 gate.
      const bound = testApp.moduleFixture.get<object>(OBJECT_STORAGE_PORT, {
        strict: false,
      });
      expect(bound).toBeDefined();
      const boundName = (bound as { constructor: { name: string } }).constructor
        .name;
      expect(boundName).toBe('S3StorageAdapter');
      expect(boundName).not.toMatch(/Fake|Mock|Stub/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-photo-09 · PATCH never writes photo; a photo upload never writes other
  // S1 fields.
  //  - Test 1 (PATCH carrying photo → 400): RED — the PATCH route's target
  //    write gate is UMAC-2's and fails closed (403) before the DTO validator
  //    is reached. The 400 assertion is the correct Stage-1 target; it goes
  //    green once the `user-management:edit` seed + UMAC-2 write gate land.
  //  - Test 2 (photo upload touches only User.photo): RED — blanket 403.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-photo-09 · PATCH /users/:id never writes photo; photo upload never writes other S1 fields [RED]', () => {
    it('Test 1 — PATCH carrying `photo` → 400 (forbidden property); no sibling field lands either', async () => {
      const bob = await fx.user('photo09-bob', { firstName: 'Bob' });
      const alice = await fx.user('photo09-alice', {
        firstName: 'Alice',
        position: 'Engineer',
        city: 'Warsaw',
        photo: null,
      });
      await fx.reportsTo(alice.id, bob.id);
      // Seed a real `user-management:edit` FR grant for Bob so the intent under
      // test — the DTO's wholesale rejection of a `photo` field — is what the
      // request exercises, not the (separate, UMAC-2) target write gate.
      await fx.grantFunctionalRole(bob.id, ['user-management:edit']);

      const res = await request(server())
        .patch(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .send({
          position: 'Senior Engineer',
          photo: 'https://evil.example/x.png',
        });
      expect(res.status).toBe(400);

      const read = await getCard(alice.id, alice.id);
      expect(read.status).toBe(200);
      expect((read.body as CardEnvelope).data.position).toBe('Engineer');
      expect((read.body as CardEnvelope).data.photo).toBeNull();
    });

    it('Test 2 — a Self photo upload changes ONLY User.photo; every other S1 field is unchanged', async () => {
      const alice = await fx.user('photo09b-alice', {
        firstName: 'Alice',
        lastName: 'Anders',
        position: 'Engineer',
        country: 'PL',
        city: 'Warsaw',
        photo: null,
      });

      const before = await getCard(alice.id, alice.id);
      expect(before.status).toBe(200);
      const beforeData = (before.body as CardEnvelope).data;
      const beforeRow = await testApp.prisma.user.findUnique({
        where: { id: alice.id },
      });

      const write = await putPhoto(alice.id, bearer(alice.id), jpeg());
      expect(write.status).toBe(200);
      const newPhoto = (write.body as UserResponseBody).photo as string;

      const after = await getCard(alice.id, alice.id);
      const afterData = (after.body as CardEnvelope).data;

      for (const key of Object.keys(beforeData)) {
        if (key === 'photo') continue;
        expect(afterData[key]).toEqual(beforeData[key]);
      }
      expect(beforeData.photo).toBeNull();
      expect(afterData.photo).toBe(newPhoto);

      // Non-S1 columns (not on the card) are untouched too.
      const afterRow = await testApp.prisma.user.findUnique({
        where: { id: alice.id },
      });
      expect(afterRow?.ttId).toBe(beforeRow?.ttId ?? null);
      expect(afterRow?.isActive).toBe(beforeRow?.isActive);
      expect(afterRow?.firstName).toBe(beforeRow?.firstName);
      expect(afterRow?.workEmail).toBe(beforeRow?.workEmail);
    });
  });
});
