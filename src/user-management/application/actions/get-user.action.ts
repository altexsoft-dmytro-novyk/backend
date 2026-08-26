import { Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import { UserService } from '../../domain/services/user.service';

@Injectable()
export class GetUserAction {
  constructor(private readonly userService: UserService) {}

  async execute(id: string): Promise<User> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }
}
