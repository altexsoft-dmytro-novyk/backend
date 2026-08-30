import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DepartureRepositoryPort } from '../domain/interfaces/departure-repository.port';

@Injectable()
export class DepartureRepository implements DepartureRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async userExists(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }

  async hasActiveManagedRelations(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM relationships WHERE holder_user_id = ${userId}::uuid
        UNION ALL
        SELECT 1 FROM departments WHERE manager_id = ${userId}::uuid
      ) AS present;
    `;
    return rows[0]?.present ?? false;
  }

  async hasPendingDeparture(userId: string): Promise<boolean> {
    const existing = await this.prisma.departure.findFirst({
      where: { userId, appliedAt: null },
      select: { id: true },
    });
    return existing !== null;
  }

  async recordDeparture(
    userId: string,
    effectiveDate: Date,
    reason: string,
    recordedBy: string,
  ) {
    return this.prisma.departure.create({
      data: { userId, effectiveDate, reason, recordedBy },
    });
  }
}
