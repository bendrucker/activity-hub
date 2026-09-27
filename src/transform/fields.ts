// A field backfill carries one published field to every row the site already
// holds, through the site's in-place update rather than a republish. A
// republish rebuilds the whole row from the decode artifacts and paces through
// the hourly sweep, which is hours of container time to move one scalar.

import { stageRows } from "../derived";
import { lakeUri } from "../lake/location";
import { subSportClient, type SubSportClient } from "./container";
import {
  activityRows,
  DELETED,
  indoor,
  indoorKnown,
  siteUpdater,
  type ActivityUpdate,
  type SiteUpdater,
} from "./publish";
import type { PublishWork } from "./protocol";

export type FieldName = keyof ActivityUpdate;

// `known` separates a value some source or file recorded from the default
// publish falls back to. Both are updated, because a republish would publish
// the default too, but a dry run reports them apart.
export type FieldValue<T> =
  | { status: "ok"; value: T; known: boolean }
  | { status: "failed"; error: string };

export interface FieldDeps {
  container: SubSportClient;
}

export interface UpdatableField<K extends FieldName> {
  compute(
    env: Env,
    activityIds: readonly string[],
    deps: FieldDeps,
  ): Promise<Map<string, FieldValue<ActivityUpdate[K]>>>;
}

// Publish reads sub_sports only where decode left an artifact, and falls back
// to the sources alone everywhere else. Reading them under the same condition
// is what keeps the updated value equal to what a republish would send.
const indoorField: UpdatableField<"indoor"> = {
  async compute(env, activityIds, deps) {
    const [registries, decodes] = await Promise.all([
      activityRows(env.REGISTRY, activityIds),
      stageRows(env.REGISTRY, "decode", activityIds),
    ]);

    const work: PublishWork[] = [];
    for (const activityId of activityIds) {
      const decode = decodes.get(activityId);
      if (decode?.status === "ok" && decode.outputKey !== null) {
        work.push({ activityId, decode: lakeUri(decode.outputKey) });
      }
    }
    const read = work.length === 0 ? { outcomes: [] } : await deps.container.subSports({ work });
    const outcomes = new Map(read.outcomes.map((outcome) => [outcome.activityId, outcome]));

    const values = new Map<string, FieldValue<boolean>>();
    for (const activityId of activityIds) {
      const registry = registries.get(activityId);
      if (registry === undefined) {
        values.set(activityId, { status: "failed", error: "activity is not in the registry" });
        continue;
      }
      const outcome = outcomes.get(activityId);
      if (outcome?.status === "failed") {
        values.set(activityId, { status: "failed", error: outcome.error });
        continue;
      }
      const subSports = outcome?.subSports ?? [];
      values.set(activityId, {
        status: "ok",
        value: indoor(registry, subSports),
        known: indoorKnown(registry, subSports),
      });
    }
    return values;
  },
};

export const UPDATABLE_FIELDS: { [K in FieldName]: UpdatableField<K> } = {
  indoor: indoorField,
};

export function isFieldName(name: string): name is FieldName {
  return Object.hasOwn(UPDATABLE_FIELDS, name);
}

// A page runs one sub_sport read and one update per activity, so it finishes
// well inside a request. D1 binds at most 100 parameters per query, and
// `stageRows` binds the stage alongside every id, so a page stops one short.
export const FIELD_PAGE = 99;

export interface FieldBackfillOptions {
  cursor?: string;
  limit?: number;
  apply?: boolean;
  site?: SiteUpdater;
  container?: SubSportClient;
}

export interface FieldBackfillPage {
  field: FieldName;
  applied: boolean;
  activities: number;
  updated: number;
  // Keyed by the value as a string, or `unknown` where no source or file
  // recorded one.
  counts: Record<string, number>;
  failures: { activityId: string; error: string }[];
  // Null once the page comes back short, which means the walk has reached the
  // end.
  nextCursor: string | null;
}

export async function backfillField(
  env: Env,
  field: FieldName,
  options: FieldBackfillOptions = {},
): Promise<FieldBackfillPage> {
  const limit = options.limit ?? FIELD_PAGE;
  const apply = options.apply ?? false;
  const activityIds = await publishedActivities(env.REGISTRY, options.cursor ?? "", limit);
  const values = await UPDATABLE_FIELDS[field].compute(env, activityIds, {
    container: options.container ?? subSportClient(env),
  });

  const counts: Record<string, number> = {};
  const failures: FieldBackfillPage["failures"] = [];
  const updates: [string, ActivityUpdate[FieldName]][] = [];
  for (const activityId of activityIds) {
    const value = values.get(activityId);
    if (value === undefined || value.status === "failed") {
      failures.push({ activityId, error: value?.error ?? "no value computed" });
      continue;
    }
    const key = value.known ? String(value.value) : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    updates.push([activityId, value.value]);
  }

  let updated = 0;
  if (apply) {
    const site = options.site ?? siteUpdater(env);
    const errors = await Promise.all(
      updates.map(([activityId, value]) =>
        site.updateActivity(activityId, { [field]: value }).then(
          () => null,
          (error: unknown) => ({ activityId, error: String(error) }),
        ),
      ),
    );
    for (const error of errors) {
      if (error === null) {
        updated += 1;
      } else {
        failures.push(error);
      }
    }
  }

  return {
    field,
    applied: apply,
    activities: activityIds.length,
    updated,
    counts,
    failures,
    nextCursor: activityIds.length < limit ? null : (activityIds.at(-1) ?? null),
  };
}

// An `ok` publish row is the record that the site holds the activity, under
// whatever artifact version wrote it. A deletion records `ok` too, with the
// sentinel fingerprint, and that row is gone from the site.
async function publishedActivities(
  db: D1Database,
  cursor: string,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT activity_id
       FROM derived
       WHERE stage = 'publish'
         AND status = 'ok'
         AND input_fingerprint != ?1
         AND activity_id > ?2
       ORDER BY activity_id
       LIMIT ?3`,
    )
    .bind(DELETED, cursor, limit)
    .all<{ activity_id: string }>();
  return results.map((row) => row.activity_id);
}
