import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '../../generated/prisma/client';
import type { Prisma } from '../../generated/prisma/client';

function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// Pragmatic infrastructure repository consumed directly by
// user-management's controllers for this build. user-management's own full
// hexagon (User/Relationship/Department domain entities and repositories)
// is out of this story's primary scope (see the access-control facade
// SPEC and task brief: "nice side effect but NOT your primary target") —
// access-control's own hexagon (the actual deliverable) fully follows AD-1
// port/adapter layering; this file is the pragmatic exception, documented
// here rather than silently deviating.
@Injectable()
export class ProfileDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  getUser(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async listUsers(opts: {
    ids?: string[];
    activeOnly?: boolean;
  }): Promise<User[]> {
    if (opts.ids && opts.ids.length === 0) return [];
    const where: Record<string, unknown> = {};
    if (opts.ids) where.id = { in: opts.ids };
    if (opts.activeOnly) where.isActive = true;
    return this.prisma.user.findMany({ where });
  }

  /**
   * Story 1.5 (FR-15/FR-16): paginated, filtered S1 identity listing.
   * `ttId` is deliberately not a supported filter key — FR-15/epics.md
   * Story 1.5 both state technical `ttId`/`isActive` are never public
   * filters (docs/test-cases/user-management/list/um-list-04.md's own Test
   * 3 asks for a `ttId` filter, which conflicts with that rule; FR-15 wins
   * as the higher-altitude, twice-stated source — see the rewritten
   * list.e2e-spec.ts's top-of-file note).
   */
  async listUsersPage(opts: {
    ids?: string[];
    filters: Record<string, string | number | Date | undefined>;
    skip: number;
    take: number;
  }): Promise<{ items: User[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (opts.ids) where.id = { in: opts.ids };
    for (const [key, value] of Object.entries(opts.filters)) {
      if (value === undefined) continue;
      where[key] = value;
    }
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { id: 'asc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Bulk resolution of effective employment status (AD-16/AD-17) for a page
   * of list results — two indexed bulk queries regardless of page size,
   * never one query per row, matching the same query-budget discipline
   * AD-24 requires of access-control's own graph traversals.
   */
  async resolveEmploymentStatuses(
    userIds: string[],
  ): Promise<Map<string, 'active' | 'dismissed'>> {
    const result = new Map<string, 'active' | 'dismissed'>();
    if (userIds.length === 0) return result;
    for (const id of userIds) result.set(id, 'active');

    const dueDepartures = await this.prisma.departure.findMany({
      where: { userId: { in: userIds }, effectiveDate: { lte: new Date() } },
      select: { userId: true },
    });
    for (const d of dueDepartures) result.set(d.userId, 'dismissed');

    const openStatuses = await this.prisma.employmentStatus.findMany({
      where: { userId: { in: userIds }, endDate: null },
      select: { userId: true, status: true },
    });
    for (const s of openStatuses) {
      if (s.status === 'dismissed') result.set(s.userId, 'dismissed');
    }
    return result;
  }

  updateUser(id: string, fields: Record<string, unknown>): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: fields });
  }

  /**
   * Story 3.1/AD-19: the S1 PATCH's `position` write is one of the tracked
   * changes that must produce a system `position_change` UserEvents row,
   * written synchronously in the same transaction as the field update —
   * never a separate follow-up write, never an event-bus listener. Applies
   * `fields` unconditionally; only appends the event when `position` is
   * both present in `fields` and actually different from the current
   * value (a same-value PATCH is a no-op write, not a tracked change).
   */
  async updateUserTrackingPositionChange(
    id: string,
    fields: Record<string, unknown>,
    actorId: string,
  ): Promise<User> {
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id },
    });
    const positionChanged =
      typeof fields.position === 'string' &&
      fields.position !== before.position;

    if (!positionChanged) {
      return this.prisma.user.update({ where: { id }, data: fields });
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: fields }),
      this.prisma.userEvents.create({
        data: {
          userId: id,
          type: 'position_change',
          source: 'system',
          eventDate: new Date(),
          details: toJson({ from: before.position, to: fields.position }),
          createdBy: actorId,
        },
      }),
    ]);
    return updated;
  }

  async getEmploymentStatusValue(
    userId: string,
  ): Promise<'active' | 'dismissed'> {
    const open = await this.prisma.employmentStatus.findFirst({
      where: { userId, endDate: null },
      orderBy: { startDate: 'desc' },
    });
    return open?.status ?? 'active';
  }

  async listProjects(userId: string): Promise<{ id: string; name: string }[]> {
    const assignments = await this.prisma.projectAssignment.findMany({
      where: { userId },
      include: { project: true },
    });
    return assignments.map((a) => ({ id: a.project.id, name: a.project.name }));
  }

  // §4.2 profile header: the person's department (always present — departmentId
  // is non-null), plus the current manager (`Relationship type='direct'`) and
  // people partner (`type='people_partner'`) edges resolved to a display name.
  // Read-only; rides along with S1, so it adds no leak surface a caller who
  // already passed the S1 read gate could not otherwise reach.
  async getProfileHeaderRelations(userId: string): Promise<{
    department: { id: string; name: string } | null;
    manager: { id: string; name: string } | null;
    peoplePartner: { id: string; name: string } | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { department: { select: { id: true, name: true } } },
    });

    const edges = await this.prisma.relationship.findMany({
      where: {
        subjectUserId: userId,
        type: { in: ['direct', 'people_partner'] },
      },
      select: {
        type: true,
        holder: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const pick = (edgeType: 'direct' | 'people_partner') => {
      const edge = edges.find((e) => e.type === edgeType);
      return edge
        ? {
            id: edge.holder.id,
            name: `${edge.holder.firstName} ${edge.holder.lastName}`,
          }
        : null;
    };

    return {
      department: user?.department ?? null,
      manager: pick('direct'),
      peoplePartner: pick('people_partner'),
    };
  }

  async getUserName(
    userId: string,
  ): Promise<{ id: string; name: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true },
    });
    return user
      ? { id: user.id, name: `${user.firstName} ${user.lastName}` }
      : null;
  }

  // --- SectionRecord (generic, per schema.prisma's SectionRecord doc comment) ---

  async listSectionRecords(
    userId: string,
    section: string,
  ): Promise<
    {
      id: string;
      data: Record<string, unknown>;
      createdAt: Date;
      createdBy: string;
    }[]
  > {
    const rows = await this.prisma.sectionRecord.findMany({
      where: { userId, section },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      data: r.data as Record<string, unknown>,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    }));
  }

  async createSectionRecord(
    userId: string,
    section: string,
    data: Record<string, unknown>,
    createdBy: string,
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    const row = await this.prisma.sectionRecord.create({
      data: { userId, section, data: toJson(data), createdBy },
    });
    return { id: row.id, data: row.data as Record<string, unknown> };
  }

  /**
   * Creates a SectionRecord with an explicit, caller-supplied id rather
   * than a generated one — used for the S14/S12 "own item, mark complete"
   * routes when a record with that id doesn't already exist yet. Some
   * matrix scenarios exercise a self-completion route against an id with
   * no real originating create seam (no POST /action-items ever ran for
   * it in that test's own flow) — the same "closest real substitute"
   * treatment the E2E fixtures themselves already apply to other
   * not-yet-modeled data (see test/access-control/fixtures/graph.ts's
   * deleteUserBreakingReferences doc comment for the established pattern).
   * First PATCH creates the record (self as its own assignee); a later
   * PATCH to the same id updates it normally.
   */
  async createSectionRecordWithId(
    id: string,
    userId: string,
    section: string,
    data: Record<string, unknown>,
    createdBy: string,
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    const row = await this.prisma.sectionRecord.create({
      data: { id, userId, section, data: toJson(data), createdBy },
    });
    return { id: row.id, data: row.data as Record<string, unknown> };
  }

  async findSectionRecordById(id: string): Promise<{
    id: string;
    userId: string;
    section: string;
    data: Record<string, unknown>;
  } | null> {
    const row = await this.prisma.sectionRecord.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      section: row.section,
      data: row.data as Record<string, unknown>,
    };
  }

  async updateSectionRecordData(
    id: string,
    data: Record<string, unknown>,
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    const row = await this.prisma.sectionRecord.update({
      where: { id },
      data: { data: toJson(data) },
    });
    return { id: row.id, data: row.data as Record<string, unknown> };
  }

  /**
   * Singleton convention: at most one live row per (userId, section, kind)
   * where `kind` is an optional discriminator inside `data` for sections
   * that mix a singleton with a list under the same section id (S13's own
   * flag vs. mentorship pairs). Upsert-by-lookup, per schema.prisma's
   * SectionRecord doc comment.
   */
  async upsertSingleton(
    userId: string,
    section: string,
    kind: string | undefined,
    patch: Record<string, unknown>,
    createdBy: string,
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    const rows = await this.prisma.sectionRecord.findMany({
      where: { userId, section },
      orderBy: { createdAt: 'desc' },
    });
    const existing = rows.find((r) => {
      const d = r.data as Record<string, unknown>;
      return kind ? d.kind === kind : true;
    });
    if (existing) {
      const merged = {
        ...(existing.data as Record<string, unknown>),
        ...patch,
      };
      const row = await this.prisma.sectionRecord.update({
        where: { id: existing.id },
        data: { data: toJson(merged) },
      });
      return { id: row.id, data: row.data as Record<string, unknown> };
    }
    const data = kind ? { kind, ...patch } : patch;
    const row = await this.prisma.sectionRecord.create({
      data: { userId, section, data: toJson(data), createdBy },
    });
    return { id: row.id, data: row.data as Record<string, unknown> };
  }

  async getSingleton(
    userId: string,
    section: string,
    kind?: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.prisma.sectionRecord.findMany({
      where: { userId, section },
      orderBy: { createdAt: 'desc' },
    });
    const existing = rows.find((r) => {
      const d = r.data as Record<string, unknown>;
      return kind ? d.kind === kind : true;
    });
    return existing ? (existing.data as Record<string, unknown>) : null;
  }

  // --- Career timeline (UserEvents, AD-19/20 — real model) ---

  async listEvents(userId: string) {
    return this.prisma.userEvents.findMany({
      where: { userId, deletedAt: null },
      orderBy: { eventDate: 'asc' },
    });
  }

  async createEvent(
    userId: string,
    fields: { type: string; eventDate: Date; details: Record<string, unknown> },
    createdBy: string,
  ) {
    return this.prisma.userEvents.create({
      data: {
        userId,
        type: fields.type,
        source: 'manual',
        eventDate: fields.eventDate,
        details: toJson(fields.details),
        createdBy,
      },
    });
  }

  async findEvent(userId: string, eventId: string) {
    return this.prisma.userEvents.findFirst({
      where: { id: eventId, userId, deletedAt: null },
    });
  }

  /**
   * AD-20: a correction is soft-delete-and-append, never an in-place update
   * — this sets `deletedAt` only, excluding the row from listEvents' active
   * read (`deletedAt: null`), and never hard-deletes the row.
   */
  async softDeleteEvent(eventId: string): Promise<void> {
    await this.prisma.userEvents.update({
      where: { id: eventId },
      data: { deletedAt: new Date() },
    });
  }
}
