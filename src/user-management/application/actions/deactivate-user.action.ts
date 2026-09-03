import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import { UserService } from '../../domain/services/user.service';

@Injectable()
export class DeactivateUserAction {
  private readonly logger = new Logger(DeactivateUserAction.name);

  constructor(private readonly userService: UserService) {}

  async execute(id: string): Promise<User> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }

    const deactivated = await this.userService.deactivate(id);
    this.logger.log(`user ${id} deactivated`);
    return deactivated;
  }
}
