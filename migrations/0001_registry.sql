CREATE TABLE activities (
  activity_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  sport TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX activities_sport_started_at ON activities (sport, started_at);

CREATE TABLE activity_sources (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  activity_id TEXT NOT NULL REFERENCES activities (activity_id),
  raw_keys TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);

CREATE UNIQUE INDEX activity_sources_activity_source ON activity_sources (activity_id, source);
