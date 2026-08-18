import { Test, TestingModule } from '@nestjs/testing';
import {
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../../../prisma/prisma.service';
import { HealthController } from '../health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  const healthResult: HealthCheckResult = {
    status: 'ok',
    info: { database: { status: 'up' } },
    error: {},
    details: { database: { status: 'up' } },
  };

  const healthCheckService = {
    check: jest.fn().mockResolvedValue(healthResult),
  };
  const prismaHealthIndicator = {
    pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: PrismaHealthIndicator, useValue: prismaHealthIndicator },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return the health check result', async () => {
    const result = await controller.check();

    expect(result).toEqual(healthResult);
    expect(healthCheckService.check).toHaveBeenCalledWith([
      expect.any(Function),
    ]);
  });
});
