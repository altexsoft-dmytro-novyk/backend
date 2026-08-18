import { Test, TestingModule } from '@nestjs/testing';
import { User } from '../../../generated/prisma/client';
import { UsersController } from '../users.controller';
import { UsersService } from '../users.service';

describe('UsersController', () => {
  let controller: UsersController;

  const user: User = {
    id: '4f1e6f2e-8bcb-4a9f-b1b6-6c9f2d3a1e00',
    email: 'user@example.com',
    name: 'John Doe',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const usersService = {
    create: jest.fn().mockResolvedValue(user),
    findAll: jest.fn().mockResolvedValue([user]),
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(user),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get(UsersController);
  });

  it('create delegates to the service', async () => {
    const dto = { email: user.email, name: 'John Doe' };

    await expect(controller.create(dto)).resolves.toEqual(user);
    expect(usersService.create).toHaveBeenCalledWith(dto);
  });

  it('findAll delegates to the service', async () => {
    await expect(controller.findAll()).resolves.toEqual([user]);
  });

  it('findOne delegates to the service', async () => {
    await expect(controller.findOne(user.id)).resolves.toEqual(user);
    expect(usersService.findOne).toHaveBeenCalledWith(user.id);
  });

  it('update delegates to the service', async () => {
    const dto = { name: 'Jane Doe' };

    await expect(controller.update(user.id, dto)).resolves.toEqual(user);
    expect(usersService.update).toHaveBeenCalledWith(user.id, dto);
  });

  it('remove delegates to the service', async () => {
    await expect(controller.remove(user.id)).resolves.toBeUndefined();
    expect(usersService.remove).toHaveBeenCalledWith(user.id);
  });
});
