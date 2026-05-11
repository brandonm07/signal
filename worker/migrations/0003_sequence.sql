-- Add step tracking for multi-touch sequence
ALTER TABLE leads ADD COLUMN step INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_leads_step ON leads(step);
