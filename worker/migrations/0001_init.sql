CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  title TEXT,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
    -- queued | sending | sent | replied | unsubscribed | bounced | failed
  scheduled_for INTEGER,
  sent_at INTEGER,
  error TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  resend_message_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_scheduled ON leads(scheduled_for);

CREATE TABLE send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  attempted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  outcome TEXT NOT NULL,        -- sent | error
  resend_message_id TEXT,
  error TEXT
);

CREATE INDEX idx_send_log_lead ON send_log(lead_id);
CREATE INDEX idx_send_log_attempted ON send_log(attempted_at);

CREATE TABLE daily_counters (
  day TEXT PRIMARY KEY,         -- YYYY-MM-DD in America/Chicago
  sent INTEGER NOT NULL DEFAULT 0
);
