-- Sessions, messages and run events for the assistant (ai-kit sqlStore, from sqlSchema()).

CREATE TABLE IF NOT EXISTS ai_kit_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  owner_id TEXT,
  parent_session_id TEXT,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_kit_sessions_owner ON ai_kit_sessions (owner_id, updated_at);

CREATE INDEX IF NOT EXISTS ai_kit_sessions_parent ON ai_kit_sessions (parent_session_id);

CREATE TABLE IF NOT EXISTS ai_kit_messages (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS ai_kit_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
