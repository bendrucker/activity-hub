CREATE TABLE derived (
  activity_id TEXT NOT NULL REFERENCES activities (activity_id),
  stage TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  output_key TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (activity_id, stage)
);

CREATE INDEX derived_stage_status ON derived (stage, status, updated_at);
