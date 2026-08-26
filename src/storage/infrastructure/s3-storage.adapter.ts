import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ObjectStoragePort } from '../domain/interfaces/object-storage.port';

@Injectable()
export class S3StorageAdapter implements ObjectStoragePort, OnModuleInit {
  private readonly logger = new Logger(S3StorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint?: string;
  private readonly region: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('AWS_S3_BUCKET');
    this.region = config.getOrThrow<string>('AWS_REGION');
    this.endpoint = config.get<string>('AWS_ENDPOINT_URL');

    this.client = new S3Client({
      region: this.region,
      endpoint: this.endpoint,
      // Path-style addressing is required by LocalStack; real AWS accepts
      // it too, so this is safe in both environments.
      forcePathStyle: Boolean(this.endpoint),
      credentials: {
        accessKeyId: config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const code = (error as { name?: string }).name;
      if (
        code === 'BucketAlreadyOwnedByYou' ||
        code === 'BucketAlreadyExists'
      ) {
        return;
      }
      this.logger.warn(
        `Could not ensure bucket "${this.bucket}" exists: ${String(error)}`,
      );
    }
  }

  async put(
    key: string,
    content: Buffer,
    contentType?: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
      }),
    );

    return this.endpoint
      ? `${this.endpoint}/${this.bucket}/${key}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
