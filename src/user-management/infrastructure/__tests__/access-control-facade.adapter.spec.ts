import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccessControlFacade } from '../../../access-control/application/access-control.facade';
import { RequireSectionAccess } from '../../application/decorators/require-section-access.decorator';
import { SectionAccessGuard } from '../../application/guards/section-access.guard';
import type { AccessControlPort } from '../../domain/interfaces/access-control.port';
import type { UserService } from '../../domain/services/user.service';
import { AccessControlFacadeAdapter } from '../access-control-facade.adapter';

// PLAT-E4-S4.1c — the unit surface for `hasSectionAccess`, the one question
// every `@RequireSectionAccess` route and the `canEdit` hint both ask.
//
// This spec exists because three of its branches are NOT observable over HTTP
// (story Design Notes):
//   · the feature half denying — every session holder is an active `User` and
//     therefore holds `profile:identity:write` via `DEFAULT_PERMISSIONS`, so no
//     real request can reach "audience says write but the feature half says
//     no", and manufacturing one by mutating the baseline at runtime is
//     forbidden;
//   · an unmapped section key (`s41c-sag-05`) — 4.1c wires exactly one section,
//     so no route declares one, and `testing-strategy.md` forbids adding a
//     test-only route to produce one. The kernel half (the real facade actually
//     returning `'none'` for an unmapped key) is `acm5-sa-06`; this file is the
//     User Management half — what the gate does *with* that `'none'`;
//   · call ORDERING — that `isAllowed` is never reached once the audience half
//     has denied. A status code cannot see a call that did not happen.
//
// The facade is stubbed through local mock consts rather than referencing port
// methods directly, keeping `@typescript-eslint/unbound-method` clean (4.1a's
// lint lesson).

const VIEWER = 'viewer-1';
const TARGET = 'target-1';
const IDENTITY = 'profile:identity';

const build = () => {
  const canAccessSection = jest.fn<
    Promise<'none' | 'read' | 'write'>,
    [string, string, string]
  >();
  const isAllowed = jest.fn<Promise<boolean>, [string, string]>();
  const adapter = new AccessControlFacadeAdapter({
    canAccessSection,
    isAllowed,
  } as unknown as AccessControlFacade);
  return { adapter, canAccessSection, isAllowed };
};

describe('AccessControlFacadeAdapter.hasSectionAccess (PLAT-E4-S4.1c)', () => {
  // Level satisfaction is by RANK, not equality (story 4.1 "Guard semantics":
  // `none: 0 < read: 1 < write: 2`). The table is exhaustive over the three
  // resolvable levels × the two requestable requirements.
  describe('rank table — a resolved level satisfies a requirement at or below it', () => {
    const cases: Array<{
      resolved: 'none' | 'read' | 'write';
      required: 'read' | 'write';
      expected: boolean;
    }> = [
      { resolved: 'none', required: 'read', expected: false },
      { resolved: 'none', required: 'write', expected: false },
      { resolved: 'read', required: 'read', expected: true },
      { resolved: 'read', required: 'write', expected: false },
      { resolved: 'write', required: 'read', expected: true },
      { resolved: 'write', required: 'write', expected: true },
    ];

    it.each(cases)(
      'resolved "$resolved" against a "$required" requirement → $expected',
      async ({ resolved, required, expected }) => {
        const { adapter, canAccessSection, isAllowed } = build();
        canAccessSection.mockResolvedValue(resolved);
        // Held by every active employee via DEFAULT_PERMISSIONS, so the
        // feature half never decides any row in this table.
        isAllowed.mockResolvedValue(true);

        await expect(
          adapter.hasSectionAccess(VIEWER, IDENTITY, required, TARGET),
        ).resolves.toBe(expected);
      },
    );

    it('asks the facade for the section it was given, for the viewer over the target', async () => {
      const { adapter, canAccessSection } = build();
      canAccessSection.mockResolvedValue('read');

      await adapter.hasSectionAccess(VIEWER, IDENTITY, 'read', TARGET);

      expect(canAccessSection).toHaveBeenCalledWith(VIEWER, IDENTITY, TARGET);
    });
  });

  // `docs/architecture/access-control.md:19`, NORMATIVE — "a new functional
  // role never widens data access ... feature permissions operate *within* the
  // holder's resolved audiences only". Mechanically: the audience half returns
  // first, so `isAllowed` cannot turn a deny into an allow. This is the defect
  // the 2026-09-03 review found in `canEditS1`, asserted here as ordering.
  describe('audience-first ordering — the feature half can only ever subtract', () => {
    it('never consults isAllowed when the audience half resolves "read" against a "write" requirement', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('read');
      // Deliberately an allow: were it consulted, the result would flip.
      isAllowed.mockResolvedValue(true);

      await expect(
        adapter.hasSectionAccess(VIEWER, IDENTITY, 'write', TARGET),
      ).resolves.toBe(false);
      expect(isAllowed).not.toHaveBeenCalled();
    });

    it('never consults isAllowed when the audience half resolves "none"', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('none');
      isAllowed.mockResolvedValue(true);

      await expect(
        adapter.hasSectionAccess(VIEWER, IDENTITY, 'write', TARGET),
      ).resolves.toBe(false);
      expect(isAllowed).not.toHaveBeenCalled();
    });

    it('subtracts: a "write" audience is still denied when the feature half denies', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('write');
      isAllowed.mockResolvedValue(false);

      await expect(
        adapter.hasSectionAccess(VIEWER, IDENTITY, 'write', TARGET),
      ).resolves.toBe(false);
      expect(isAllowed).toHaveBeenCalledWith(VIEWER, 'profile:identity:write');
    });
  });

  // D1's feature half is `'<section>:write'` and belongs to the write
  // requirement alone. §3.2 decides reads by audience, and DEFAULT_PERMISSIONS
  // holds no `:read` key — a uniform `'<section>:<level>'` derivation would ask
  // for `profile:identity:read`, which nobody holds, and 403 every read.
  describe('the feature half is `<section>:write`, and only a "write" requirement has one', () => {
    it('a "read" requirement never calls isAllowed', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('write');
      isAllowed.mockResolvedValue(false);

      await expect(
        adapter.hasSectionAccess(VIEWER, IDENTITY, 'read', TARGET),
      ).resolves.toBe(true);
      expect(isAllowed).not.toHaveBeenCalled();
    });

    it('a "write" requirement consults `<section>:write`, never `user-management:edit`', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('write');
      isAllowed.mockResolvedValue(true);

      await expect(
        adapter.hasSectionAccess(VIEWER, IDENTITY, 'write', TARGET),
      ).resolves.toBe(true);
      expect(isAllowed).toHaveBeenCalledTimes(1);
      expect(isAllowed).toHaveBeenCalledWith(VIEWER, 'profile:identity:write');
      expect(isAllowed).not.toHaveBeenCalledWith(
        VIEWER,
        'user-management:edit',
      );
    });

    it('derives the feature key from the section it was asked about', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('write');
      isAllowed.mockResolvedValue(true);

      await adapter.hasSectionAccess(VIEWER, 'profile:leave', 'write', TARGET);

      expect(isAllowed).toHaveBeenCalledWith(VIEWER, 'profile:leave:write');
    });
  });

  // s41c-sag-05 — a section absent from `SECTION_ACCESS_MATRIX`. The kernel
  // resolves it to `'none'` *successfully* (acm5-sa-06); this is what the gate
  // does with that answer: deny, without throwing, without logging-and-allowing,
  // and without ever reaching the feature half.
  describe('s41c-sag-05 · an unmapped section fails closed', () => {
    it('Test 1 · "read" over an unmapped section → false, isAllowed untouched', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('none');

      await expect(
        adapter.hasSectionAccess(VIEWER, 'profile:mentorship', 'read', TARGET),
      ).resolves.toBe(false);
      expect(isAllowed).not.toHaveBeenCalled();
    });

    it('Test 2 · "write" over an unmapped section → false, isAllowed untouched', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('none');

      await expect(
        adapter.hasSectionAccess(VIEWER, 'profile:mentorship', 'write', TARGET),
      ).resolves.toBe(false);
      // No grant of `profile:mentorship:write` could have rescued it: the
      // audience half short-circuited before the feature half.
      expect(isAllowed).not.toHaveBeenCalled();
    });

    it('Test 3 · the retired "S1" identifier is just an unmatched string → false', async () => {
      const { adapter, canAccessSection } = build();
      canAccessSection.mockResolvedValue('none');

      await expect(
        adapter.hasSectionAccess(VIEWER, 'S1', 'write', TARGET),
      ).resolves.toBe(false);
      // 4.1b's rename left no magic-string special case on this side either —
      // 'S1' is passed through to the facade like any other key.
      expect(canAccessSection).toHaveBeenCalledWith(VIEWER, 'S1', TARGET);
    });
  });

  // The gate and the hint must be one code path, not two copies of one rule.
  describe('canEditIdentityCard is the same question the PATCH gate asks', () => {
    it('resolves through hasSectionAccess with profile:identity / write', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('write');
      isAllowed.mockResolvedValue(true);

      await expect(adapter.canEditIdentityCard(VIEWER, TARGET)).resolves.toBe(
        true,
      );
      expect(canAccessSection).toHaveBeenCalledWith(VIEWER, IDENTITY, TARGET);
      expect(isAllowed).toHaveBeenCalledWith(VIEWER, 'profile:identity:write');
    });

    it('a colleague audience yields canEdit false without consulting a functional grant', async () => {
      const { adapter, canAccessSection, isAllowed } = build();
      canAccessSection.mockResolvedValue('read');
      isAllowed.mockResolvedValue(true);

      await expect(adapter.canEditIdentityCard(VIEWER, TARGET)).resolves.toBe(
        false,
      );
      expect(isAllowed).not.toHaveBeenCalled();
    });
  });
});

// s41c-sag-05 Test 4 — the guard's half of the fail-closed path: it translates
// the port's `false` into a `ForbiddenException` (→ 403). Over HTTP this is
// already exercised by `s41c-sag-02`; here it is pinned against the unmapped
// section, which no route can produce.
describe('SectionAccessGuard (PLAT-E4-S4.1c)', () => {
  const contextFor = (
    handler: (...args: unknown[]) => unknown,
    request: unknown,
  ) =>
    ({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const decorate = (section: string, level: 'read' | 'write') => {
    const handler = () => undefined;
    RequireSectionAccess(section, level)({}, 'handler', {
      value: handler,
    } as TypedPropertyDescriptor<unknown>);
    return handler;
  };

  const buildGuard = (
    hasSectionAccess: jest.Mock,
    findById: jest.Mock = jest
      .fn()
      .mockResolvedValue({ id: TARGET, isActive: true }),
  ) => {
    const port = { hasSectionAccess } as unknown as AccessControlPort;
    const users = { findById } as unknown as UserService;
    return new SectionAccessGuard(new Reflector(), port, users);
  };

  const request = { session: { userId: VIEWER }, params: { id: TARGET } };

  it('s41c-sag-05 Test 4 · a false from the port becomes ForbiddenException', async () => {
    const hasSectionAccess = jest.fn().mockResolvedValue(false);
    const guard = buildGuard(hasSectionAccess);
    const handler = decorate('profile:mentorship', 'read');

    await expect(
      guard.canActivate(contextFor(handler, request)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(hasSectionAccess).toHaveBeenCalledWith(
      VIEWER,
      'profile:mentorship',
      'read',
      TARGET,
    );
  });

  it('passes the declared section and level through and allows on true', async () => {
    const hasSectionAccess = jest.fn().mockResolvedValue(true);
    const guard = buildGuard(hasSectionAccess);
    const handler = decorate(IDENTITY, 'write');

    await expect(guard.canActivate(contextFor(handler, request))).resolves.toBe(
      true,
    );
    expect(hasSectionAccess).toHaveBeenCalledWith(
      VIEWER,
      IDENTITY,
      'write',
      TARGET,
    );
  });

  // umac-11 / CONFLICT-UM-01 (PM/AD-24): a hidden target is a 404 decided
  // before the port is ever asked a section or feature question.
  it.each([
    ['missing', null],
    ['inactive', { id: TARGET, isActive: false }],
  ])(
    'umac-11 · a %s target becomes NotFoundException before any port call',
    async (_label, row) => {
      const hasSectionAccess = jest.fn().mockResolvedValue(true);
      const findById = jest.fn().mockResolvedValue(row);
      const guard = buildGuard(hasSectionAccess, findById);
      const handler = decorate(IDENTITY, 'write');

      await expect(
        guard.canActivate(contextFor(handler, request)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(findById).toHaveBeenCalledWith(TARGET);
      expect(hasSectionAccess).not.toHaveBeenCalled();
    },
  );

  it('a handler with no @RequireSectionAccess metadata passes through with no port call', async () => {
    const hasSectionAccess = jest.fn();
    const findById = jest.fn();
    const guard = buildGuard(hasSectionAccess, findById);
    const handler = () => undefined;

    await expect(guard.canActivate(contextFor(handler, request))).resolves.toBe(
      true,
    );
    expect(hasSectionAccess).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });
});
