-- Overnight lead scoring. A daily job scores unscored queued leads against
-- the Signal Advisory ICP and emails Brandon a top-N digest.
ALTER TABLE leads ADD COLUMN lead_score INTEGER;       -- 0-100, null = unscored
ALTER TABLE leads ADD COLUMN lead_tier TEXT;           -- hot | warm | nurture | skip
ALTER TABLE leads ADD COLUMN score_reason TEXT;        -- one-line justification
ALTER TABLE leads ADD COLUMN opening_angle TEXT;       -- suggested hook
ALTER TABLE leads ADD COLUMN scored_at INTEGER;        -- unix epoch
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score);
