-- Remplacent strftime('%Y-%m-%dT%H:%M:%fZ','now') de SQLite : même format de texte ISO-8601 UTC.
CREATE OR REPLACE FUNCTION fruty_now() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE OR REPLACE FUNCTION fruty_ago(i interval) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT to_char((now() - i) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
