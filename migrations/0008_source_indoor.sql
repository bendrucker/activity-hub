-- Whether the source's own activity type says the activity happened indoors.
-- NULL until ingest or the backfill has read that type.
ALTER TABLE activity_sources ADD COLUMN indoor INTEGER;
