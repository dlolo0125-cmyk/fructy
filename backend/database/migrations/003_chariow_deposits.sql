-- Paiements Chariow liés aux dépôts SikaPlus de 4 000 FCFA.
CREATE TABLE IF NOT EXISTS chariow_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount = 4000),
  product_id TEXT NOT NULL,
  sale_id TEXT UNIQUE,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')) ,
  deposit_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_chariow_orders_user ON chariow_orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chariow_pulse_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
