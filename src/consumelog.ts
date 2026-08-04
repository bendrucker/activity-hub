import type { IngestMessage } from "./ingest";

// Queue invocations have no response and their console output is regularly
// unreachable, so the handler leaves a rolling trail in KV that the admin
// surface can read back.
const KEY = "debug:consume-log";
const LIMIT = 200;

export interface ConsumeLogEntry {
  at: string;
  source: string;
  kind: string;
  id: number;
  outcome: string;
}

export function consumeLogEntry(
  message: IngestMessage,
  outcome: string,
): ConsumeLogEntry {
  return {
    at: new Date().toISOString(),
    source: message.source,
    kind: message.kind,
    id: message.source === "wahoo" ? message.workoutId : message.objectId,
    outcome,
  };
}

export async function appendConsumeLog(
  kv: KVNamespace,
  entries: ConsumeLogEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const merged = [...(await readConsumeLog(kv)), ...entries];
  await kv.put(KEY, JSON.stringify(merged.slice(-LIMIT)));
}

export async function readConsumeLog(
  kv: KVNamespace,
): Promise<ConsumeLogEntry[]> {
  const raw = await kv.get(KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConsumeLogEntry[]) : [];
  } catch {
    return [];
  }
}
