import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { User } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import type { UserEntity } from '../domain/entities/user.entity';
import type {
  UserEditPatch,
  UserListFilter,
  UserListPage,
  UserRepositoryPort,
} from '../domain/interfaces/user.repository.port';
import type { SystemEventInput } from '../domain/interfaces/user-event.repository.port';

@Injectable()
export class UserRepository implements UserRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  findByWorkEmail(workEmail: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { workEmail } });
  }

  async create(props: UserEntity, createdBy: string): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: {
          firstName: props.firstName,
          lastName: props.lastName,
          position: props.position,
          country: props.country,
          city: props.city,
          workEmail: props.workEmail,
          workPhone: props.workPhone,
          birthDay: props.birthDay,
          birthMonth: props.birthMonth,
          companyJoinDate: props.companyJoinDate,
          ttId: props.ttId,
          createdBy,
        },
      });
    } catch (error) {
      throw this.mapKnownError(error);
    }
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async update(
    id: string,
    patch: UserEditPatch,
    systemEvents: SystemEventInput[] = [],
  ): Promise<User> {
    try {
      if (systemEvents.length === 0) {
        return await this.prisma.user.update({ where: { id }, data: patch });
      }
      // AD-11: the user update and its triggered auto-events commit together or
      // not at all.
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({ where: { id }, data: patch });
        for (const event of systemEvents) {
          await tx.userEvent.create({
            data: {
              userId: event.userId,
              type: event.type,
              eventDate: event.eventDate,
              details: event.details as Prisma.InputJsonValue,
              source: event.source,
              createdBy: event.createdBy,
            },
          });
        }
        return updated;
      });
    } catch (error) {
      throw this.mapKnownError(error);
    }
  }

  deactivate(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async list(
    filter: UserListFilter,
    page: number,
    pageSize: number,
  ): Promise<UserListPage> {
    const { employmentStatus, ...identity } = filter;

    // The current employment fact = the row with `validTo IS NULL`. "Dismissed"
    // means that row exists and is `status='dismissed'`; anything else
    // (including no current row at all) counts as active (README §6).
    const currentDismissed: Prisma.EmploymentStatusListRelationFilter = {
      some: { validTo: null, status: 'dismissed' },
    };
    const employmentStatusWhere: Prisma.UserWhereInput =
      employmentStatus === 'dismissed'
        ? { employmentStatuses: currentDismissed }
        : { NOT: { employmentStatuses: currentDismissed } };

    const where: Prisma.UserWhereInput = {
      ...identity,
      // Purged rows are never listed, regardless of any filter (decisions §
      // "isActive is not a filter").
      isActive: true,
      ...employmentStatusWhere,
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        include: {
          employmentStatuses: {
            where: { validTo: null },
            select: { status: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  private mapKnownError(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        'A user with this workEmail or ttId already exists',
      );
    }
    return error;
  }
}
