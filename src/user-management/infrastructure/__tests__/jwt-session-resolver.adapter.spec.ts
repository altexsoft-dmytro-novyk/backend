import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { DepartureMetricsService } from '../departure-metrics.service';
import { JwtSessionResolverAdapter } from '../jwt-session-resolver.adapter';
import { signSessionJwt } from '../jwt.util';

// DEPT-4 — the unit surface for `resolveJwtSubject`, the only staleness check
// the stateless session JWT has (adapter doc comment `:78-85`).
//
// This spec exists because the branch is NOT observable over HTTP with the
// existing e2e suites: every other suite authenticates with the
// `Bearer <token:<uuid>>` persona shorthand, which short-circuits before the
// JWT path, and the one real-JWT e2e (`um-auth-03`) uses an active subject.
// Reverting `resolveJwtSubject` to `return { userId: sub }` therefore leaves
// the whole suite green — this file is what fails instead.

const SECRET = 'dept4-unit-secret';

const jwtFor = (sub: string) => {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signSessionJwt({ sub, iat: now, exp: now + 3600 }, SECRET)}`;
};

const build = () => {
  const findUnique = jest.fn<
    Promise<{ id: string; isActive: boolean } | null>,
    unknown[]
  >();
  const queryRawUnsafe = jest.fn<Promise<unknown[]>, unknown[]>();
  queryRawUnsafe.mockResolvedValue([]); // no due departure by default

  const prisma = {
    user: { findUnique, findFirst: jest.fn(), create: jest.fn() },
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as PrismaService;

  const departureMetrics = {
    recordRequestTimeCutoffDenial: jest.fn(),
  } as unknown as DepartureMetricsService;

  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'SESSION_JWT_SECRET' ? SECRET : false,
    ),
  } as unknown as ConfigService;

  const adapter = new JwtSessionResolverAdapter(
    prisma,
    departureMetrics,
    config,
  );
  return { adapter, findUnique, queryRawUnsafe };
};

describe('JwtSessionResolverAdapter.resolveJwtSubject (DEPT-4)', () => {
  it('resolves a signature-valid JWT whose subject is an active User', async () => {
    const { adapter, findUnique } = build();
    findUnique.mockResolvedValue({ id: 'user-active', isActive: true });

    const session = await adapter.resolve(jwtFor('user-active'));

    expect(session).toEqual({ userId: 'user-active' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-active' },
      select: { id: true, isActive: true },
    });
  });

  it('returns null when the subject names a deactivated User', async () => {
    // The regression this spec guards: a token minted while the person was
    // active must stop resolving the moment `isActive` flips to false — the
    // stateless JWT carries no other signal.
    const { adapter, findUnique } = build();
    findUnique.mockResolvedValue({ id: 'user-gone', isActive: false });

    await expect(adapter.resolve(jwtFor('user-gone'))).resolves.toBeNull();
  });

  it('returns null when the subject names no User (deleted or DB reset)', async () => {
    const { adapter, findUnique } = build();
    findUnique.mockResolvedValue(null);

    await expect(adapter.resolve(jwtFor('user-missing'))).resolves.toBeNull();
  });

  it('returns null for a tampered token without touching the database', async () => {
    const { adapter, findUnique } = build();
    const tampered = `${jwtFor('user-active')}x`;

    await expect(adapter.resolve(tampered)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null for a JWT signed with the wrong secret', async () => {
    const { adapter, findUnique } = build();
    const now = Math.floor(Date.now() / 1000);
    const wrong = `Bearer ${signSessionJwt(
      { sub: 'user-active', iat: now, exp: now + 3600 },
      'not-the-secret',
    )}`;

    await expect(adapter.resolve(wrong)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('still applies the effective-departure cutoff to an otherwise-valid JWT session', async () => {
    const { adapter, findUnique, queryRawUnsafe } = build();
    findUnique.mockResolvedValue({ id: 'user-departing', isActive: true });
    queryRawUnsafe.mockResolvedValue([{ hit: 1 }]); // a due departure

    await expect(adapter.resolve(jwtFor('user-departing'))).resolves.toBeNull();
  });
});
