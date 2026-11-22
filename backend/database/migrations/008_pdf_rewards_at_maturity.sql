-- Les nouveaux achats accumulent les récompenses quotidiennement puis les versent
-- en une seule fois dans le portefeuille de gains à l'échéance.
-- Les achats antérieurs restent en mode legacy pour ne pas recréditer des sommes déjà versées.
ALTER TABLE product_accesses ADD COLUMN reward_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (reward_mode IN ('legacy','maturity'));
ALTER TABLE product_accesses ADD COLUMN rewards_paid_at TEXT;
CREATE INDEX IF NOT EXISTS ix_product_accesses_maturity ON product_accesses(reward_mode, rewards_paid_at, expires_at);
