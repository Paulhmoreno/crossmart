export interface StoredFile {
  key: string;
  /** Public URL the file can be fetched from. */
  url: string;
}

/** A file found by listing the storage, such as when recording files stored before tracking. */
export interface ListedFile extends StoredFile {
  byteSize: number;
}

/** A file read back from Crossmart's own storage for binary channel uploads. */
export interface ReadStoredFile {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

/**
 * Where uploaded files live. Implementations: `LocalFileStorage` now, S3-compatible
 * object storage (S3, R2) for the cloud.
 */
export abstract class FileStorage {
  /** Stores the content under `key`, which must come from the server, never from a client. */
  abstract put(key: string, content: Buffer, contentType: string): Promise<StoredFile>;

  /** Deletes the file; resolves as well when there is no file under `key`. */
  abstract delete(key: string): Promise<void>;

  /** Every file under the folder `prefix`, nested ones included; none when it is empty. */
  abstract list(prefix: string): AsyncIterable<ListedFile>;

  /** Reads a file back when `url` belongs to this storage's public base URL; null otherwise. */
  readByUrl?(url: string): Promise<ReadStoredFile | null>;
}
