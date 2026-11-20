-- Fruty : banque de 50 questions (4 tirées au hasard par jour) et bonus d'accueil.
CREATE TABLE IF NOT EXISTS question_bank (
  id INTEGER PRIMARY KEY,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option INTEGER NOT NULL CHECK (correct_option BETWEEN 0 AND 3),
  explanation TEXT NOT NULL DEFAULT '',
  last_used_date TEXT
);
CREATE TABLE IF NOT EXISTS user_bonuses (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('welcome','purchase')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, kind)
);
