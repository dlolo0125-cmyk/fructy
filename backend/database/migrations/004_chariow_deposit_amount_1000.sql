-- Le montant Chariow passe à 1 000 FCFA. Les commandes historiques sont conservées.
CREATE TABLE IF NOT EXISTS deposit_options (amount INTEGER PRIMARY KEY,label TEXT,pay_url TEXT);
ALTER TABLE chariow_orders RENAME TO chariow_orders_v3;
CREATE TABLE chariow_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  product_id TEXT NOT NULL,
  sale_id TEXT UNIQUE,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  deposit_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
INSERT INTO chariow_orders(id,user_id,amount,product_id,sale_id,transaction_id,status,deposit_ref,created_at,completed_at)
SELECT id,user_id,amount,product_id,sale_id,transaction_id,status,deposit_ref,created_at,completed_at FROM chariow_orders_v3;
DROP TABLE chariow_orders_v3;
CREATE INDEX IF NOT EXISTS ix_chariow_orders_user ON chariow_orders(user_id, created_at DESC);
INSERT OR IGNORE INTO deposit_options(amount,label,pay_url) VALUES (1000,'Dépôt Chariow',NULL);
