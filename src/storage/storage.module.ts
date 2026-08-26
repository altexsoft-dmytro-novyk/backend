import { Global, Module } from '@nestjs/common';
import { StoreObjectAction } from './application/actions/store-object.action';
import { OBJECT_STORAGE_PORT } from './domain/interfaces/object-storage.port';
import { ObjectStorageService } from './domain/services/object-storage.service';
import { S3StorageAdapter } from './infrastructure/s3-storage.adapter';

@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE_PORT, useClass: S3StorageAdapter },
    ObjectStorageService,
    StoreObjectAction,
  ],
  exports: [StoreObjectAction],
})
export class StorageModule {}
