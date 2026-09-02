import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

    // Object first, then row (profile/README decision 6): a failed `put` must
    // leave `User.photo` untouched — no half-apply, no dangling reference. A
    // connection failure / timeout against the object store surfaces as `503`
    // (decision 7 — transient dependency outage, invites retry).
    const key = `photos/${id}/${uuidv7()}`;
    let storedRef: string;
    try {
      storedRef = await this.storeObjectAction.execute(
        key,
        content,
        contentType,
      );
    } catch {
      throw new ServiceUnavailableException(
        'photo storage is temporarily unavailable',
      );
    }
    return this.userService.update(id, { photo: storedRef });
  }
}
