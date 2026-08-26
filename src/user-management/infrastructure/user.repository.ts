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

  async update(id: string, patch: UserEditPatch): Promise<User> {
    try {
      return await this.prisma.user.update({ where: { id }, data: patch });
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
    const where = {
      ...filter,
      // Default to active-only unless the caller explicitly asked for a
      // specific isActive value (including explicitly false).
      isActive: filter.isActive ?? true,
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'asc' },
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
