import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  MagicLinkTokenRecord,
  MagicLinkTokenRepositoryPort,
  MintMagicLinkTokenInput,
} from '../domain/interfaces/magic-link-token.repository.port';

/** Epic 2 — Prisma-backed `magic_link_token` store (Story 2.1 mint, Story 2.2 consume). */
@Injectable()
export class MagicLinkTokenRepository implements MagicLinkTokenRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async mint(input: MintMagicLinkTokenInput): Promise<void> {
    await this.prisma.magicLinkToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  async findByHash(tokenHash: string): Promise<MagicLinkTokenRecord | null> {
    return this.prisma.magicLinkToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, consumedAt: true },
    });
  }

  async markConsumed(id: string): Promise<boolean> {
    // Conditional update — only the caller that flips `consumedAt` from NULL
    // wins; a racing replay updates 0 rows and gets `false`.
    const { count } = await this.prisma.magicLinkToken.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }
}
