import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { User } from '../../../generated/prisma/client';
import { StoreObjectAction } from '../../../storage/application/actions/store-object.action';
import { UserService } from '../../domain/services/user.service';

@Injectable()
export class UploadUserPhotoAction {
  constructor(
    private readonly userService: UserService,
    private readonly storeObjectAction: StoreObjectAction,
  ) {}

  async execute(
    id: string,
    content: Buffer,
    contentType?: string,
  ): Promise<User> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }

    const key = `photos/${id}/${uuidv7()}`;
    const storedRef = await this.storeObjectAction.execute(
      key,
      content,
      contentType,
    );
    return this.userService.update(id, { photo: storedRef });
  }
}
