import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { User } from '../../../../generated/prisma/client';
import type { CurrentEdge } from '../../../domain/interfaces/org-relationship-reader.port';
import type { OrgRelationshipReadService } from '../../../domain/services/org-relationship-read.service';
import type { OrgRelationshipsReadAccessService } from '../../../domain/services/org-relationships-read-access.service';
import type { UserService } from '../../../domain/services/user.service';
import { GetRelationshipsAction } from '../get-relationships.action';

// Story 6.1 — unit coverage for the `GET /users/:id/relationships` action's
// I/O-matrix branches with every port faked (AD-15: the real audience walk /
// Prisma query are proven in `test/user-management/epic-4/relationships-read.e2e-spec.ts`).

const VIEWER = 'viewer-1';
const SUBJECT = 'subject-1';

const activeUser = (id: string): User =>
  ({ id, isActive: true }) as unknown as User;
const inactiveUser = (id: string): User =>
  ({ id, isActive: false }) as unknown as User;

interface Fakes {
  findById: jest.Mock;
  canRead: jest.Mock;
  listCurrentEdges: jest.Mock;
}

const build = (overrides: Partial<Fakes> = {}) => {
  const fakes: Fakes = {
    findById: jest.fn().mockResolvedValue(activeUser(SUBJECT)),
    canRead: jest.fn().mockResolvedValue(true),
    listCurrentEdges: jest.fn().mockResolvedValue([]),
    ...overrides,
  };

  const action = new GetRelationshipsAction(
    { findById: fakes.findById } as unknown as UserService,
    { canRead: fakes.canRead } as unknown as OrgRelationshipsReadAccessService,
    {
      listCurrentEdges: fakes.listCurrentEdges,
    } as unknown as OrgRelationshipReadService,
  );

  return { action, fakes };
};

describe('GetRelationshipsAction', () => {
  it('um-rel-23 · missing target → NotFoundException, before the reader gate', async () => {
    const { action, fakes } = build({
      findById: jest.fn().mockResolvedValue(null),
    });

    await expect(action.execute(VIEWER, SUBJECT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fakes.canRead).not.toHaveBeenCalled();
    expect(fakes.listCurrentEdges).not.toHaveBeenCalled();
  });

  it('um-rel-23 · inactive target → NotFoundException, before the reader gate', async () => {
    const { action, fakes } = build({
      findById: jest.fn().mockResolvedValue(inactiveUser(SUBJECT)),
    });

    await expect(action.execute(VIEWER, SUBJECT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fakes.canRead).not.toHaveBeenCalled();
  });

  it('um-rel-21 · active target, not entitled → ForbiddenException, no edge read', async () => {
    const { action, fakes } = build({
      canRead: jest.fn().mockResolvedValue(false),
    });

    await expect(action.execute(VIEWER, SUBJECT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fakes.listCurrentEdges).not.toHaveBeenCalled();
  });

  it('um-rel-20 · entitled, no edges → { data: [] }', async () => {
    const { action } = build();

    await expect(action.execute(VIEWER, SUBJECT)).resolves.toEqual({
      data: [],
    });
  });

  it('um-rel-18 · entitled, both edges → mapped CurrentEdgeView[] with relationshipId + target identity', async () => {
    const edges: CurrentEdge[] = [
      {
        id: 'rel-direct',
        type: 'direct',
        target: { id: 'mgr', firstName: 'Mona', lastName: 'Manager' },
      },
      {
        id: 'rel-pp',
        type: 'people_partner',
        target: { id: 'pp', firstName: 'Pat', lastName: 'Partner' },
      },
    ];
    const { action } = build({
      listCurrentEdges: jest.fn().mockResolvedValue(edges),
    });

    await expect(action.execute(VIEWER, SUBJECT)).resolves.toEqual({
      data: [
        {
          relationshipId: 'rel-direct',
          type: 'direct',
          target: { id: 'mgr', firstName: 'Mona', lastName: 'Manager' },
        },
        {
          relationshipId: 'rel-pp',
          type: 'people_partner',
          target: { id: 'pp', firstName: 'Pat', lastName: 'Partner' },
        },
      ],
    });
  });

  it('passes viewer + subject through to the reader gate', async () => {
    const { action, fakes } = build();

    await action.execute(VIEWER, SUBJECT);

    expect(fakes.canRead).toHaveBeenCalledWith(VIEWER, SUBJECT);
    expect(fakes.listCurrentEdges).toHaveBeenCalledWith(SUBJECT);
  });
});
