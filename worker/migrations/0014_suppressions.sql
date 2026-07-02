-- Durable do-not-email list. Rows here outlive lead rows: deleting a lead,
-- re-importing a list, or manually re-queuing can never resurrect a
-- suppressed address, because processSend() checks this table at the moment
-- of send. Every suppression path writes here: List-Unsubscribe clicks,
-- spam complaints, hard bounces, and reply-based unsubscribes (including
-- replies that could not be matched to a lead).
CREATE TABLE suppressions (
  email TEXT PRIMARY KEY,      -- always stored lowercased
  reason TEXT NOT NULL,        -- unsubscribed | bounced | complaint | declined
  source TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Backfill from lead statuses so existing opt-outs are durable from day one.
INSERT OR IGNORE INTO suppressions (email, reason, source)
  SELECT lower(email),
         CASE status WHEN 'bounced' THEN 'bounced' ELSE 'unsubscribed' END,
         'backfill from leads.status'
    FROM leads
   WHERE status IN ('unsubscribed', 'bounced');

-- Pastor Derrick Abell (Fellowship of Grace) declined via a reply to manual
-- (non-pitcher) outreach on 2026-06-18; no lead row exists to carry that
-- state, which is exactly what this table is for.
INSERT OR IGNORE INTO suppressions (email, reason, source) VALUES
  ('derrick.abell@gmail.com', 'declined', 'reply to manual outreach, 2026-06-18');
