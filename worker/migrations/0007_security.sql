-- Security hardening: login throttling + data retention timestamps

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  outcome TEXT NOT NULL,    -- ok | fail
  attempted_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);
