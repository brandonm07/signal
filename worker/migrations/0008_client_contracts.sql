-- Client technology contracts for the Renewal Defense workflow.
-- One row per (client × provider × service). Daily cron scans for
-- contracts expiring in 180/90/30 days and emails a digest.
CREATE TABLE IF NOT EXISTS client_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  provider TEXT NOT NULL,            -- "Comcast Business", "AT&T", etc.
  service_type TEXT NOT NULL,        -- "internet", "voice", "mobile", "cloud", "security", "other"
  monthly_spend_cents INTEGER NOT NULL DEFAULT 0,
  contract_start INTEGER,            -- unix epoch; nullable
  contract_expiration INTEGER NOT NULL, -- unix epoch
  auto_renew_notice_days INTEGER NOT NULL DEFAULT 0, -- notice required to opt-out (0 = no auto-renew)
  notes TEXT,
  -- Alert idempotency: set to unix epoch when an alert at that tier has fired.
  alerted_180_at INTEGER,
  alerted_90_at INTEGER,
  alerted_30_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_client_contracts_client ON client_contracts(client_id);
CREATE INDEX IF NOT EXISTS idx_client_contracts_expiration ON client_contracts(contract_expiration);
