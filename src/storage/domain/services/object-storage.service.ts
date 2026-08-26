import { Inject, Injectable } from '@nestjs/common';
import {
  OBJECT_STORAGE_PORT,
  type ObjectStoragePort,
} from '../interfaces/object-storage.port';

// The only holder of OBJECT_STORAGE_PORT (AD-2) — application/actions/
// depend on this service, never the port token directly.
@Injectable()
export class ObjectStorageService {
  constructor(
    @Inject(OBJECT_STORAGE_PORT)
    private readonly objectStorage: ObjectStoragePort,
  ) {}

  put(key: string, content: Buffer, contentType?: string): Promise<string> {
    return this.objectStorage.put(key, content, contentType);
  }
}
