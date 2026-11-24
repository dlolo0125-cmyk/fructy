CREATE TABLE auth_attempts (
 identifier_hash char(64) PRIMARY KEY,
 failed_count integer NOT NULL DEFAULT 0 CHECK(failed_count>=0),
 window_started_at timestamptz NOT NULL DEFAULT now(),
 locked_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_locked_idx ON auth_attempts(locked_until) WHERE locked_until IS NOT NULL;
