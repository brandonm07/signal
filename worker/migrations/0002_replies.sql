-- Track every inbound reply we observe, even non-meeting ones.
CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_thread_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  intent TEXT,                  -- meeting | unsubscribe | bounce | ooo | other
  intent_confidence REAL,
  draft_id TEXT,                -- gmail draft id if we created one
  draft_mode_active INTEGER NOT NULL DEFAULT 1, -- 1 = drafted, 0 = auto-sent
  received_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_replies_lead ON replies(lead_id);
CREATE INDEX idx_replies_intent ON replies(intent);

-- Cursor for "what's the latest Gmail historyId we've processed".
-- One row, key='gmail_history_id'.
CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
