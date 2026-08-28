import { S3Client } from "bun";
import { endpoint, LAKE_BUCKET, RAW_BUCKET, type ContainerConfig } from "./env";

export interface RawStore {
  // Throws when the object is missing. A raw key the registry recorded but R2
  // does not hold is a per-activity failure, not an empty result to decode.
  get(key: string): Promise<Uint8Array>;
}

export interface LakeStore {
  put(key: string, path: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
}

export interface Stores {
  raw: RawStore;
  lake: LakeStore;
}

export function stores(config: ContainerConfig): Stores {
  return {
    raw: rawStore(
      new S3Client({
        bucket: RAW_BUCKET,
        endpoint: endpoint(config.accountId),
        region: "auto",
        ...config.raw,
      }),
    ),
    lake: lakeStore(
      new S3Client({
        bucket: LAKE_BUCKET,
        endpoint: endpoint(config.accountId),
        region: "auto",
        ...config.lake,
      }),
    ),
  };
}

export function rawStore(client: S3Client): RawStore {
  return {
    async get(key) {
      try {
        return new Uint8Array(await client.file(key).arrayBuffer());
      } catch (error) {
        throw s3Error(error);
      }
    },
  };
}

export function lakeStore(client: S3Client): LakeStore {
  return {
    async put(key, path) {
      try {
        await client.write(key, Bun.file(path));
      } catch (error) {
        throw s3Error(error);
      }
    },
    async putJson(key, value) {
      try {
        await client.write(key, JSON.stringify(value));
      } catch (error) {
        throw s3Error(error);
      }
    },
  };
}

// Bun's S3Error puts the whole signal on `code` (NoSuchKey, AccessDenied,
// ConnectionRefused) and leaves `message` as the fixed string "an unexpected
// error has occurred". That message is what a failed outcome would otherwise
// carry into the derived table.
export function s3Error(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string") {
    return error;
  }
  return new Error(`${code}: ${error.message}`, { cause: error });
}
