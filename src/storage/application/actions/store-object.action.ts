import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '../../domain/services/object-storage.service';

// The only class other contexts import from `storage/` (AD-2 entry-point
// rule) — nothing outside this module ever names the domain service, the
// port, or the adapter directly.
@Injectable()
export class StoreObjectAction {
  constructor(private readonly objectStorage: ObjectStorageService) {}

  execute(key: string, content: Buffer, contentType?: string): Promise<string> {
    return this.objectStorage.put(key, content, contentType);
  }
}
