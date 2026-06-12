-- Daily call brief support: track when a lead last appeared on Brandon's
-- call sheet (so the same lead doesn't repeat all week), and a phone column
-- for future enrichment (cold lists don't carry numbers today).
ALTER TABLE leads ADD COLUMN briefed_at INTEGER;
ALTER TABLE leads ADD COLUMN phone TEXT;
