CREATE TABLE audit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  company TEXT NOT NULL,
  email TEXT NOT NULL,
  carrier TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | contacted | uploaded | delivered | declined
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_audit_status ON audit_requests(status);
CREATE INDEX idx_audit_email ON audit_requests(email);
