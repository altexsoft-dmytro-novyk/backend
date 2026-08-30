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

  updateUser(id: string, fields: Record<string, unknown>): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: fields });
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
}
