ALTER TABLE audit_requests ADD COLUMN upload_token TEXT UNIQUE;
ALTER TABLE audit_requests ADD COLUMN uploaded_at INTEGER;
ALTER TABLE audit_requests ADD COLUMN uploaded_filename TEXT;
ALTER TABLE audit_requests ADD COLUMN uploaded_size INTEGER;
ALTER TABLE audit_requests ADD COLUMN r2_key TEXT;

CREATE INDEX idx_audit_upload_token ON audit_requests(upload_token);
