-- Delivery/engagement events from the Resend webhook (delivered | opened |
-- clicked). Bounces and complaints are tracked on leads.status; this table
-- captures the positive-funnel signals so the weekly report can show
-- delivery and open/click rates. Open/click events only arrive if tracking
-- is enabled on the Resend domain.
CREATE TABLE email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT,
  recipient TEXT,
  event_type TEXT NOT NULL,   -- delivered | opened | clicked
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_email_events_type_time ON email_events(event_type, created_at);
