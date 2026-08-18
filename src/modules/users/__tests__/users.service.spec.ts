import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, User } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UsersService } from '../users.service';

describe('UsersService', () => {
  let service: UsersService;

  const user: User = {
    id: '4f1e6f2e-8bcb-4a9f-b1b6-6c9f2d3a1e00',
    email: 'user@example.com',
    name: 'John Doe',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const prisma = {
    user: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const knownError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('error', {
      code,
      clientVersion: 'test',
    });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UsersService);
  });

  describe('create', () => {
    it('creates a user', async () => {
      prisma.user.create.mockResolvedValue(user);

      await expect(
        service.create({ email: user.email, name: user.name ?? undefined }),
      ).resolves.toEqual(user);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: user.email, name: user.name },
      });
    });

    it('throws ConflictException on duplicate email (P2002)', async () => {
      prisma.user.create.mockRejectedValue(knownError('P2002'));

      await expect(service.create({ email: user.email })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findAll', () => {
    it('returns users ordered by createdAt desc', async () => {
      prisma.user.findMany.mockResolvedValue([user]);

      await expect(service.findAll()).resolves.toEqual([user]);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findOne', () => {
    it('returns a user by id', async () => {
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(service.findOne(user.id)).resolves.toEqual(user);
    });

    it('throws NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates a user', async () => {
      const updated = { ...user, name: 'Jane Doe' };
      prisma.user.update.mockResolvedValue(updated);

      await expect(
        service.update(user.id, { name: 'Jane Doe' }),
      ).resolves.toEqual(updated);
    });

    it('throws NotFoundException when user does not exist (P2025)', async () => {
      prisma.user.update.mockRejectedValue(knownError('P2025'));

      await expect(service.update('missing-id', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes a user', async () => {
      prisma.user.delete.mockResolvedValue(user);

      await expect(service.remove(user.id)).resolves.toBeUndefined();
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: user.id },
      });
    });

    it('throws NotFoundException when user does not exist (P2025)', async () => {
      prisma.user.delete.mockRejectedValue(knownError('P2025'));

      await expect(service.remove('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
