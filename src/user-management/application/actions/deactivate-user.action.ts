import { Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import { UserService } from '../../domain/services/user.service';

@Injectable()
export class DeactivateUserAction {
  constructor(private readonly userService: UserService) {}

  async execute(id: string): Promise<User> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }

    return this.userService.deactivate(id);
  }
}
