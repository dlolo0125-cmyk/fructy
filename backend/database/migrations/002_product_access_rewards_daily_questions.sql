-- SikaPlus V2.2 : accès PDF à durée limitée et questions quotidiennes.
-- Migration strictement additive : les tables V1 et leurs historiques sont conservés.
PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN access_days INTEGER NOT NULL DEFAULT 0 CHECK (access_days BETWEEN 0 AND 3650);
ALTER TABLE products ADD COLUMN daily_reward INTEGER NOT NULL DEFAULT 0 CHECK (daily_reward >= 0);

CREATE TABLE IF NOT EXISTS product_accesses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price INTEGER NOT NULL CHECK (price >= 0),
  access_days INTEGER NOT NULL DEFAULT 0 CHECK (access_days BETWEEN 0 AND 3650),
  daily_reward INTEGER NOT NULL DEFAULT 0 CHECK (daily_reward >= 0),
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((access_days = 0 AND expires_at IS NULL) OR (access_days > 0 AND expires_at IS NOT NULL)),
  CHECK (access_days > 0 OR daily_reward = 0)
);
CREATE INDEX IF NOT EXISTS ix_product_accesses_user ON product_accesses(user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS ix_product_accesses_product ON product_accesses(product_id, user_id);

-- Reprise des anciens achats : ils restent accessibles sans expiration ni récompense nouvelle.
INSERT INTO product_accesses(id,user_id,product_id,price,access_days,daily_reward,purchased_at,expires_at)
SELECT 'legacy-' || lower(hex(randomblob(16))), old.user_id, old.product_id, old.price, 0, 0,
       COALESCE(old.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), NULL
FROM purchases old
WHERE NOT EXISTS (
  SELECT 1 FROM product_accesses a
  WHERE a.user_id=old.user_id AND a.product_id=old.product_id
);

CREATE TABLE IF NOT EXISTS product_reward_credits (
  id TEXT PRIMARY KEY,
  access_id TEXT NOT NULL REFERENCES product_accesses(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  reward_number INTEGER NOT NULL CHECK (reward_number > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  credited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(access_id, reward_number)
);
CREATE INDEX IF NOT EXISTS ix_product_reward_user ON product_reward_credits(user_id, credited_at DESC);

CREATE TABLE IF NOT EXISTS daily_questions (
  id TEXT PRIMARY KEY,
  question_date TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option INTEGER NOT NULL CHECK (correct_option BETWEEN 0 AND 3),
  explanation TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_daily_questions_date ON daily_questions(question_date, active, sort_order);

CREATE TABLE IF NOT EXISTS daily_question_answers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  question_id TEXT NOT NULL REFERENCES daily_questions(id) ON DELETE RESTRICT,
  question_date TEXT NOT NULL,
  selected_option INTEGER NOT NULL CHECK (selected_option BETWEEN 0 AND 3),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  answered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, question_id)
);
CREATE INDEX IF NOT EXISTS ix_daily_answers_user_date ON daily_question_answers(user_id, question_date);
