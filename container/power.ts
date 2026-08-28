// Power bests: for each activity and each duration on the ladder, the highest
// average power sustained over any window of that length.

import { quote } from "./sql";

// Nineteen durations rather than every second. A full-second curve is ten
// million rows to answer questions nobody asks at that resolution, and the
// points below are the ones a rider reads: neuromuscular through anaerobic in
// seconds, threshold and endurance in minutes.
export const POWER_DURATIONS: readonly number[] = [
  5, 10, 15, 20, 30, 45, 60, 120, 180, 300, 480, 600, 720, 900, 1200, 1800, 2400, 3000, 3600,
];

// Long form: one row per activity per duration, columns activity_id,
// duration_s, watts. `records` is a SELECT over record rows carrying
// activity_id, timestamp and power.
//
// Windows roll over a zero-filled 1 Hz elapsed grid, which is what makes a
// stop count as real time at zero watts. Compressing pauses out would splice
// two unrelated efforts into one window and report a 20-minute best the rider
// never rode.
export function powerBestsSql(records: string): string {
  const rolled = POWER_DURATIONS.map(
    (duration) =>
      // A window shorter than its duration is an average over fewer seconds
      // than it claims, so a 90-second ride reports no 20-minute best rather
      // than a deflated one.
      `CASE WHEN t - t0 >= ${duration - 1} THEN AVG(power) OVER (
         PARTITION BY activity_id ORDER BY t
         ROWS BETWEEN ${duration - 1} PRECEDING AND CURRENT ROW
       ) END AS ${quote(String(duration))}`,
  );
  const columns = POWER_DURATIONS.map((duration) => quote(String(duration))).join(", ");

  return `
    WITH samples AS (${records}),
    -- One row per elapsed second. A device that logs faster than 1 Hz gives
    -- several samples the same second, and taking the max of them keeps the
    -- grid dense without averaging away a spike.
    seconds AS (
      SELECT activity_id, CAST(epoch(timestamp) AS BIGINT) AS t, MAX(power) AS power
      FROM samples
      WHERE timestamp IS NOT NULL
      GROUP BY activity_id, t
    ),
    -- HAVING drops the activities with no power at all, which would otherwise
    -- come out of the zero-fill as a full ladder of zero-watt bests.
    bounds AS (
      SELECT activity_id, MIN(t) AS t0, MAX(t) AS t1
      FROM seconds
      GROUP BY activity_id
      HAVING COUNT(power) > 0
    ),
    -- unnest of the scalar generate_series rather than a lateral join to the
    -- table function: DuckDB cannot put an outer join on the correlated side
    -- of one, and the zero-fill is exactly an outer join.
    elapsed AS (
      SELECT activity_id, t0, unnest(generate_series(t0, t1)) AS t
      FROM bounds
    ),
    grid AS (
      SELECT elapsed.activity_id, elapsed.t0, elapsed.t, COALESCE(seconds.power, 0) AS power
      FROM elapsed
      LEFT JOIN seconds
        ON seconds.activity_id = elapsed.activity_id AND seconds.t = elapsed.t
    ),
    rolled AS (
      SELECT activity_id, ${rolled.join(", ")}
      FROM grid
    ),
    -- UNPIVOT drops nulls, so the partial windows excluded above never reach
    -- the aggregate.
    long AS (
      UNPIVOT rolled ON ${columns} INTO NAME duration_s VALUE watts
    )
    SELECT activity_id, CAST(duration_s AS BIGINT) AS duration_s, MAX(watts) AS watts
    FROM long
    GROUP BY activity_id, duration_s`;
}
