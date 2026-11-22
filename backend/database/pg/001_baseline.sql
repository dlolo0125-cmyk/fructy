-- Fruty : schéma PostgreSQL (état final équivalent aux migrations SQLite 001 à 008).
-- Les dates restent des textes ISO-8601 UTC, comme dans SQLite, pour conserver exactement le comportement du code.

CREATE TABLE IF NOT EXISTS profiles(id text primary key,phone text unique not null,hash text not null,role text not null default 'client',code text unique not null,inviter text,
 wallet_sub integer not null default 0 check(wallet_sub>=0),wallet_gain integer not null default 0 check(wallet_gain>=0),vip integer not null default 0,active integer not null default 0,
 nom text,prenom text,email text,method text,paynum text,totp text,totp_ok integer not null default 0,created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

CREATE TABLE IF NOT EXISTS products(id text primary key,sym text not null,name text not null,color text default '#7C3AED',price integer,teaser text,image_url text,hidden integer not null default 0,pos integer default 0,facts text,body text,pdf_url text, access_days INTEGER NOT NULL DEFAULT 0 CHECK (access_days BETWEEN 0 AND 3650), daily_reward INTEGER NOT NULL DEFAULT 0 CHECK (daily_reward >= 0));

CREATE TABLE IF NOT EXISTS course_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  category_id TEXT REFERENCES course_categories(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner','intermediate','advanced')),
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (length(currency)=3),
  cover_image TEXT,
  estimated_minutes INTEGER NOT NULL DEFAULT 0 CHECK (estimated_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS course_modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL CHECK (content_type IN ('video','pdf','text','external')),
  content_url TEXT,
  body TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_preview INTEGER NOT NULL DEFAULT 0 CHECK (is_preview IN (0,1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id TEXT REFERENCES course_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pass_percent INTEGER NOT NULL DEFAULT 70 CHECK (pass_percent BETWEEN 1 AND 100),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1))
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option INTEGER NOT NULL CHECK (correct_option >= 0),
  explanation TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  course_id TEXT REFERENCES courses(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (length(currency)=3),
  payer_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','confirmed','failed','cancelled','refunded')),
  provider_payload TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  confirmed_at TEXT,
  refunded_at TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  paid_amount INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (length(currency)=3),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','refunded','revoked')),
  enrolled_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE(user_id, course_id)
);

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  certificate_code TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  revoked_at TEXT,
  UNIQUE(user_id, course_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  payload TEXT,
  received_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS deposit_options(amount integer primary key,label text,pay_url text);

CREATE TABLE IF NOT EXISTS deposits(id text primary key,user_id text not null,amount integer not null,ref text unique not null,status text not null default 'attente',created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

CREATE TABLE IF NOT EXISTS withdrawals(id text primary key,user_id text not null,amount integer not null,method text,dest text,status text not null default 'attente',created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

CREATE TABLE IF NOT EXISTS purchases(user_id text,product_id text,price integer,created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),primary key(user_id,product_id));

CREATE TABLE IF NOT EXISTS task_log(user_id text,day text,task_id text,primary key(user_id,day,task_id));

CREATE TABLE IF NOT EXISTS ledger(id bigint generated by default as identity primary key,user_id text,kind text,amount integer,created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

CREATE TABLE IF NOT EXISTS announcements(id text primary key,title text,body text,created_at text default(to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS chariow_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  product_id TEXT NOT NULL,
  sale_id TEXT UNIQUE,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  deposit_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS chariow_pulse_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
, sale_id TEXT, order_id TEXT, outcome TEXT NOT NULL DEFAULT 'received');

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
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS daily_question_answers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  question_id TEXT NOT NULL REFERENCES daily_questions(id) ON DELETE RESTRICT,
  question_date TEXT NOT NULL,
  selected_option INTEGER NOT NULL CHECK (selected_option BETWEEN 0 AND 3),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  answered_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE(user_id, question_id)
);

CREATE TABLE IF NOT EXISTS product_accesses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price INTEGER NOT NULL CHECK (price >= 0),
  access_days INTEGER NOT NULL DEFAULT 0 CHECK (access_days BETWEEN 0 AND 3650),
  daily_reward INTEGER NOT NULL DEFAULT 0 CHECK (daily_reward >= 0),
  purchased_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), reward_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (reward_mode IN ('legacy','maturity')), rewards_paid_at TEXT,
  CHECK ((access_days = 0 AND expires_at IS NULL) OR (access_days > 0 AND expires_at IS NOT NULL)),
  CHECK (access_days > 0 OR daily_reward = 0)
);

CREATE TABLE IF NOT EXISTS product_reward_credits (
  id TEXT PRIMARY KEY,
  access_id TEXT NOT NULL REFERENCES product_accesses(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  reward_number INTEGER NOT NULL CHECK (reward_number > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  credited_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE(access_id, reward_number)
);

CREATE TABLE IF NOT EXISTS question_bank (
  id INTEGER PRIMARY KEY,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option INTEGER NOT NULL CHECK (correct_option BETWEEN 0 AND 3),
  explanation TEXT NOT NULL DEFAULT '',
  last_used_date TEXT
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  score_percent INTEGER NOT NULL CHECK (score_percent BETWEEN 0 AND 100),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  answers_json TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  invited_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  qualifying_payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (length(currency)=3),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE(invited_id),
  CHECK(inviter_id <> invited_id)
);

CREATE TABLE IF NOT EXISTS reward_campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (length(currency)=3),
  budget_total INTEGER NOT NULL DEFAULT 0 CHECK (budget_total >= 0),
  budget_spent INTEGER NOT NULL DEFAULT 0 CHECK (budget_spent >= 0 AND budget_spent <= budget_total),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  validation_type TEXT NOT NULL DEFAULT 'manual' CHECK (validation_type IN ('manual','course_completion','quiz_pass','admin_approved')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS reward_claims (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES reward_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  reviewed_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE(campaign_id, user_id)
);

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
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS user_bonuses (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('welcome','purchase')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  claimed_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  last_position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (last_position_seconds >= 0),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  PRIMARY KEY(user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_reference
ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_payments_user_created ON payments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_payments_status_created ON payments(status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_enrollments_user ON enrollments(user_id, enrolled_at DESC);

CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_audit_created ON admin_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS ix_product_accesses_user ON product_accesses(user_id, purchased_at DESC);

CREATE INDEX IF NOT EXISTS ix_product_accesses_product ON product_accesses(product_id, user_id);

CREATE INDEX IF NOT EXISTS ix_product_reward_user ON product_reward_credits(user_id, credited_at DESC);

CREATE INDEX IF NOT EXISTS ix_daily_questions_date ON daily_questions(question_date, active, sort_order);

CREATE INDEX IF NOT EXISTS ix_daily_answers_user_date ON daily_question_answers(user_id, question_date);

CREATE INDEX IF NOT EXISTS ix_chariow_orders_user ON chariow_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_chariow_deliveries_order ON chariow_pulse_deliveries(order_id, received_at DESC);

CREATE INDEX IF NOT EXISTS ix_saspay_orders_user ON saspay_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_product_accesses_maturity ON product_accesses(reward_mode, rewards_paid_at, expires_at);


-- Stockage des fichiers dans la base (le disque de Render Free est éphémère).
CREATE TABLE IF NOT EXISTS product_files(
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TABLE IF NOT EXISTS product_images(
  filename TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TABLE IF NOT EXISTS app_secrets(
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
