-- Fructy V12: nouveau schéma PostgreSQL. Montants en unités entières de FCFA.
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'client' CHECK(role IN ('client','admin')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','closed')),
 referral_code text NOT NULL UNIQUE, referred_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 first_name text, last_name text, email text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK(referred_by IS NULL OR referred_by <> id)
);
CREATE TABLE user_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash char(64) NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id,expires_at);

CREATE TABLE wallets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 wallet_type text NOT NULL CHECK(wallet_type IN ('deposit','earnings')), currency char(3) NOT NULL DEFAULT 'XOF',
 balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,wallet_type,currency)
);
CREATE TABLE ledger_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, entry_type text NOT NULL,
 amount bigint NOT NULL CHECK(amount<>0), currency char(3) NOT NULL DEFAULT 'XOF',
 reference_type text NOT NULL, reference_id text NOT NULL, idempotency_key text NOT NULL UNIQUE,
 description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_created_idx ON ledger_entries(user_id,created_at DESC);

CREATE TABLE payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('saspay','chariow','manual')), provider_reference text,
 idempotency_key text NOT NULL UNIQUE, amount bigint NOT NULL CHECK(amount>0), currency char(3) NOT NULL DEFAULT 'XOF',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','succeeded','failed','cancelled','refunded')),
 payer_phone text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz, UNIQUE(provider,provider_reference)
);
CREATE INDEX payment_intents_user_idx ON payment_intents(user_id,created_at DESC);
CREATE TABLE provider_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_id text NOT NULL,
 payment_intent_id uuid REFERENCES payment_intents(id) ON DELETE RESTRICT, event_type text NOT NULL,
 signature_valid boolean NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 processed_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,provider_event_id)
);
CREATE TABLE withdrawals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT, amount bigint NOT NULL CHECK(amount>0),
 method text NOT NULL, destination text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected','cancelled')),
 idempotency_key text NOT NULL UNIQUE, reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text NOT NULL DEFAULT '',
 price bigint NOT NULL CHECK(price>=0), currency char(3) NOT NULL DEFAULT 'XOF', file_key text,
 access_days integer NOT NULL DEFAULT 0 CHECK(access_days BETWEEN 0 AND 3650),
 daily_reward bigint NOT NULL DEFAULT 0 CHECK(daily_reward>=0), published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(access_days>0 OR daily_reward=0)
);
CREATE TABLE product_accesses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT, price_paid bigint NOT NULL CHECK(price_paid>=0),
 purchased_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, rewards_paid_at timestamptz
);
CREATE INDEX product_accesses_user_idx ON product_accesses(user_id,expires_at);
CREATE TABLE product_reward_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_access_id uuid NOT NULL REFERENCES product_accesses(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, reward_number integer NOT NULL CHECK(reward_number>0),
 amount bigint NOT NULL CHECK(amount>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_access_id,reward_number)
);

CREATE TABLE course_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
 sort_order integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true
);
CREATE TABLE courses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid REFERENCES course_categories(id) ON DELETE RESTRICT,
 title text NOT NULL, slug text NOT NULL UNIQUE, description text NOT NULL DEFAULT '',
 price bigint NOT NULL DEFAULT 0 CHECK(price>=0), currency char(3) NOT NULL DEFAULT 'XOF',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE course_modules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 title text NOT NULL, sort_order integer NOT NULL DEFAULT 0
);
CREATE TABLE lessons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), module_id uuid NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
 title text NOT NULL, content_type text NOT NULL CHECK(content_type IN ('video','pdf','text','external')),
 content text NOT NULL DEFAULT '', sort_order integer NOT NULL DEFAULT 0, published boolean NOT NULL DEFAULT false
);
CREATE TABLE enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','revoked')),
 enrolled_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,course_id)
);
CREATE TABLE lesson_progress (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 progress_percent smallint NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 100),
 completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,lesson_id)
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, body text NOT NULL DEFAULT '', read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL, target_type text, target_id text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit_logs(created_at DESC);
CREATE TABLE daily_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), question_date date NOT NULL, prompt text NOT NULL,
 options jsonb NOT NULL, correct_option smallint NOT NULL CHECK(correct_option BETWEEN 0 AND 3),
 explanation text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true, UNIQUE(question_date,prompt)
);
CREATE TABLE daily_question_answers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 question_id uuid NOT NULL REFERENCES daily_questions(id) ON DELETE RESTRICT,
 selected_option smallint NOT NULL CHECK(selected_option BETWEEN 0 AND 3), is_correct boolean NOT NULL,
 reward_amount bigint NOT NULL DEFAULT 0 CHECK(reward_amount>=0), answered_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,question_id)
);
CREATE TABLE app_settings (
 key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
