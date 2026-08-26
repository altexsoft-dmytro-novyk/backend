export interface ObjectStoragePort {
  // Stores `content` under `key` and returns the reference (URL) other
  // code persists to reach it again later.
  put(key: string, content: Buffer, contentType?: string): Promise<string>;
}

export const OBJECT_STORAGE_PORT = Symbol('OBJECT_STORAGE_PORT');
