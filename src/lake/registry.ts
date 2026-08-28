// The container holds no bindings, so the registry reaches the lake build as
// an object rather than a query. Exporting it per run also pins what the build
// saw: a rebuild from the same snapshot produces the same tables even after
// the registry has moved on.

const REGISTRY_PREFIX = "lake/registry/v1/";

// One object per run rather than a fixed key: a trigger landing while a build
// is running would otherwise overwrite the snapshot that build is still
// reading, since the container re-reads the URI for every table. Colons and
// dots leave the timestamp so the key stays plain for DuckDB's S3 reader.
export function registryRunKey(startedAt: Date): string {
  return `${REGISTRY_PREFIX}${startedAt.toISOString().replace(/[:.]/g, "-")}.ndjson`;
}

// D1 caps a response at 1,000 rows well before it caps bytes, so the export
// pages. The order is stable so a snapshot diffs cleanly against the previous
// one.
const PAGE = 1000;

interface RegistryRow {
  activity_id: string;
  started_at: string;
  timezone: string;
  sport: string;
  duration_s: number;
  strava_id: string | null;
  wahoo_id: string | null;
  deleted_at: string | null;
}

// Sources are pivoted into one column per provider because the lake joins on
// the Strava id and a row per source would fan the activity out.
const EXPORT = `
  SELECT
    a.activity_id                                   AS activity_id,
    a.started_at                                    AS started_at,
    a.timezone                                      AS timezone,
    a.sport                                         AS sport,
    a.duration_s                                    AS duration_s,
    MAX(CASE WHEN s.source = 'strava' THEN s.source_id END) AS strava_id,
    MAX(CASE WHEN s.source = 'wahoo'  THEN s.source_id END) AS wahoo_id,
    -- An activity counts as deleted only when every source that produced it
    -- has been deleted, so a Strava delete on a ride Wahoo also uploaded
    -- leaves the row live.
    CASE WHEN COUNT(s.source_id) = COUNT(s.deleted_at)
         THEN MAX(s.deleted_at) END                 AS deleted_at
  FROM activities a
  LEFT JOIN activity_sources s ON s.activity_id = a.activity_id
  GROUP BY a.activity_id, a.started_at, a.timezone, a.sport, a.duration_s
  ORDER BY a.activity_id
  LIMIT ?1 OFFSET ?2`;

export interface RegistrySnapshot {
  key: string;
  activities: number;
}

export async function exportRegistry(
  db: D1Database,
  bucket: R2Bucket,
  key: string,
): Promise<RegistrySnapshot> {
  const lines: string[] = [];

  for (let offset = 0; ; offset += PAGE) {
    // Offset pagination: whether another page exists is only knowable from
    // this one's row count.
    // oxlint-disable-next-line no-await-in-loop
    const { results } = await db.prepare(EXPORT).bind(PAGE, offset).all<RegistryRow>();
    for (const row of results) {
      lines.push(JSON.stringify(row));
    }
    if (results.length < PAGE) {
      break;
    }
  }

  // A trailing newline keeps the last row readable as its own line, which is
  // what newline-delimited JSON readers expect.
  await bucket.put(key, `${lines.join("\n")}\n`, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  return { key, activities: lines.length };
}
