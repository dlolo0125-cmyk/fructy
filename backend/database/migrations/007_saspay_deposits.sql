-- Dépôts SasPay (Softpay) : le client saisit seulement numéro + réseau + montant.
CREATE TABLE IF NOT EXISTS saspay_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1000 AND 100000),
  network TEXT NOT NULL,
  phone TEXT NOT NULL,
  payment_id TEXT UNIQUE,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  deposit_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_saspay_orders_user ON saspay_orders(user_id, created_at DESC);
