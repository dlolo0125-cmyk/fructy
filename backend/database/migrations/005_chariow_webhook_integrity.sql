-- Traçabilité des notifications Chariow sans stocker de données sensibles du payeur.
ALTER TABLE chariow_pulse_deliveries ADD COLUMN sale_id TEXT;
ALTER TABLE chariow_pulse_deliveries ADD COLUMN order_id TEXT;
ALTER TABLE chariow_pulse_deliveries ADD COLUMN outcome TEXT NOT NULL DEFAULT 'received';
CREATE INDEX IF NOT EXISTS ix_chariow_deliveries_order ON chariow_pulse_deliveries(order_id, received_at DESC);
