import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { IdentityPort } from '../domain/interfaces/identity.port';

@Injectable()
export class PrismaIdentityAdapter implements IdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set<string>();
    }

    // One lookup for the viewer and every target together. The §7 budget is
    // 500 targets in 2 seconds, so identity-before-derivation has to cost one
    // query for the whole request, not one per party.
    //
    // `isActive` is filtered here rather than selected and checked in the
    // resolver so that a deactivated row and an absent row come back the same
    // way: not in the result. CAP-1 denies both identically, and a resolver
    // that could tell them apart would invite a branch that treats one of them
    // as recoverable.
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true },
    });

    return new Set(rows.map((row) => row.id));
  }
}
