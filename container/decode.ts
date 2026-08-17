import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBInstance } from "@duckdb/node-api";
import type { TelemetryActivity } from "../src/import/telemetry";
import { writeActivityParquet } from "./parquet";
import type {
  DecodeOutcome,
  DecodeRequest,
  DecodeResponse,
  DecodeWork,
} from "../src/transform/protocol";
import type { LakeStore, RawStore } from "./storage";

// Decoding is synchronous JS and blocks the loop, so concurrency buys overlap
// between one activity's decode and another's R2 transfer or Parquet write
// rather than parallel decoding. Four matches the vCPU count of the instance
// size this runs on and bounds peak memory: every activity in flight holds its
// full decoded row set, and a batch of a hundred held at once would not fit.
export const DECODE_CONCURRENCY = 4;

const DECODABLE = [".fit", ".fit.gz", ".gpx", ".gpx.gz"];

export type Decoder = (
  bytes: Uint8Array,
  filename: string,
) => Promise<TelemetryActivity>;

export interface DecodeDeps {
  raw: RawStore;
  lake: LakeStore;
  instance: DuckDBInstance;
  decode: Decoder;
}

export async function decodeBatch(
  request: DecodeRequest,
  deps: DecodeDeps,
): Promise<DecodeResponse> {
  const outcomes = await mapConcurrent(
    request.work,
    DECODE_CONCURRENCY,
    (work) => decodeActivity(work, deps),
  );
  return { outcomes };
}

export function outputKey(activityId: string): string {
  return `decode/v1/${activityId}/`;
}

async function decodeActivity(
  work: DecodeWork,
  deps: DecodeDeps,
): Promise<DecodeOutcome> {
  const key = work.rawKeys.find(decodable);
  if (key === undefined) {
    return {
      activityId: work.activityId,
      status: "skipped",
      reason: `no decodable raw key among [${work.rawKeys.join(", ")}]`,
    };
  }

  try {
    const bytes = await deps.raw.get(key);
    const activity = await deps.decode(bytes, key);
    await publish(work.activityId, key, activity, deps);
    return {
      activityId: work.activityId,
      status: "ok",
      outputKey: outputKey(work.activityId),
      rawKey: key,
      records: activity.records.length,
      laps: activity.laps.length,
      sessions: activity.sessions.length,
      errors: activity.errors,
    };
  } catch (error) {
    return {
      activityId: work.activityId,
      status: "failed",
      error: `${key}: ${message(error)}`,
    };
  }
}

async function publish(
  activityId: string,
  rawKey: string,
  activity: TelemetryActivity,
  deps: DecodeDeps,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "decode-"));
  try {
    const files = await writeActivityParquet(
      deps.instance,
      directory,
      activityId,
      rawKey,
      activity,
    );
    const prefix = outputKey(activityId);
    for (const file of files) {
      await deps.lake.put(`${prefix}${file.name}`, file.path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function decodable(key: string): boolean {
  const lowered = key.toLowerCase();
  return DECODABLE.some((extension) => lowered.endsWith(extension));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let index = next++; index < items.length; index = next++) {
        const item = items[index];
        if (item === undefined) {
          throw new Error(`no work at index ${index}`);
        }
        results[index] = await run(item);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
