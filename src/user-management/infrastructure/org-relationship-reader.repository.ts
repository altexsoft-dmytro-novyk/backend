import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CurrentEdge,
  OrgRelationshipReaderPort,
} from '../domain/interfaces/org-relationship-reader.port';

// Story 6.1 — the Prisma-backed reader for `GET /users/:id/relationships`. One
// `findMany` + `reportsTo` include, no N+1 (pattern: `departure.repository.ts`
// `loadPlatformBlockersOn`). Read-only: no `tx`, no journal row, no write.
// `Relationship` is hard-deleted, so a row's existence IS "current"; the partial
// UNIQUE indexes hold each type to ≤1 per subject.

// Explicit response order — manager (`direct`) edge first, then People Partner,
// then by `id`. Sorted in code rather than left to `enum RelationshipType`
// declaration order (which agrees today but is not a contract).
const TYPE_RANK: Record<CurrentEdge['type'], number> = {
  direct: 0,
  people_partner: 1,
};

@Injectable()
export class OrgRelationshipReaderRepository implements OrgRelationshipReaderPort {
  constructor(private readonly prisma: PrismaService) {}

  async listCurrentEdges(subjectId: string): Promise<CurrentEdge[]> {
    const rows = await this.prisma.relationship.findMany({
      where: {
        userId: subjectId,
        type: { in: ['direct', 'people_partner'] },
        // An edge pointing at a deactivated user is not a valid "current" edge
        // (a departed manager/PP is not who you report to). This also makes
        // `reportsTo` non-null for every returned row.
        reportsTo: { isActive: true },
      },
      include: {
        reportsTo: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    return rows
      .map((row) => ({
        id: row.id,
        // Sound: the `where: { type: { in: ['direct', 'people_partner'] } }`
        // filter above is what constrains `row.type` to these two members.
        type: row.type as CurrentEdge['type'],
        // `reportsTo` is always present here — `direct` / `people_partner` rows
        // always carry `reportsToUserId`, and the `reportsTo: { isActive: true }`
        // filter further requires the related row to exist and be active.
        target: {
          id: row.reportsTo!.id,
          firstName: row.reportsTo!.firstName,
          lastName: row.reportsTo!.lastName,
        },
      }))
      .sort(
        (a, b) =>
          TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.id.localeCompare(b.id),
      );
  }
}
