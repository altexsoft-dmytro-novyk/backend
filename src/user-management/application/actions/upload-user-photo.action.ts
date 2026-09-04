import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { User } from '../../../generated/prisma/client';
import { StoreObjectAction } from '../../../storage/application/actions/store-object.action';
import { UserService } from '../../domain/services/user.service';

@Injectable()
export class UploadUserPhotoAction {
  private readonly logger = new Logger(UploadUserPhotoAction.name);

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
    } catch (error) {
      // Expected transient dependency outage — mapped to 503 below and re-logged
      // with its stack by `LoggingInterceptor`. Here we add only the domain
      // context (which user), at `warn`, without a second stack.
      this.logger.warn(
        `photo storage unavailable for user ${id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'photo storage is temporarily unavailable',
      );
    }
    this.logger.log(`photo stored for user ${id} (key ${key})`);
    return this.userService.update(id, { photo: storedRef });
  }
}
