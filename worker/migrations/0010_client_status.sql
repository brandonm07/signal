-- Distinguish vetted clients from unvetted self-service signups.
-- active | prospect. Admin-created clients default to active; the portal
-- signup flow inserts prospects explicitly.
ALTER TABLE clients ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
