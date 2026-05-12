-- Billing subsystem: clients, invoices, line items, event log
-- Every monetary value stored as INTEGER cents. Never use REAL/FLOAT for money.

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_legal_name TEXT NOT NULL,
  signatory_name TEXT,
  signatory_title TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'US',
  ein_last_four TEXT,
  stripe_customer_id TEXT,
  msa_signed_at INTEGER,
  msa_doc_url TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_clients_stripe_customer
  ON clients(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_clients_email ON clients(email);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  invoice_number TEXT NOT NULL,
  description TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'draft',
    -- draft | sent | paid | void | overdue
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  view_token TEXT NOT NULL,
  due_date INTEGER,
  sent_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE UNIQUE INDEX idx_invoices_view_token ON invoices(view_token);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_status ON invoices(status);

CREATE TABLE invoice_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_line_items_invoice ON invoice_line_items(invoice_id);

-- Audit trail + idempotency. stripe_event_id unique constraint prevents
-- double-processing of duplicate webhook deliveries.
CREATE TABLE invoice_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER REFERENCES invoices(id),
  stripe_event_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_invoice_events_stripe
  ON invoice_events(stripe_event_id) WHERE stripe_event_id IS NOT NULL;
CREATE INDEX idx_invoice_events_invoice ON invoice_events(invoice_id);

-- Sequential invoice numbering per calendar year.
CREATE TABLE invoice_counter (
  year INTEGER PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);
