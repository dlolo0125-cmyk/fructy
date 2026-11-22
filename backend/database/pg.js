'use strict';
// Couche d'accès PostgreSQL (Neon) : remplace node:sqlite.
// - Les requêtes gardent la syntaxe "?" du code historique (converties en $1, $2...).
// - tx() sérialise toutes les transactions avec un verrou consultatif, ce qui reproduit
//   exactement le comportement de "BEGIN IMMEDIATE" de SQLite : une seule transaction
//   d'écriture à la fois (aucun double crédit possible, même en cas de requêtes simultanées).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

// count(*) et sum() renvoient des bigint/numeric : on les veut en nombres JS.
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1700, v => Number(v));

const TX_LOCK_KEY = 7340001;
const MIGRATION_LOCK_KEY = 7340002;
const als = new AsyncLocalStorage();

function createDb(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL manquante : renseignez la chaîne de connexion Neon dans les variables d’environnement.');
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000, // Neon peut mettre 1 à 2 s à se réveiller
    keepAlive: true
  });
  pool.on('error', err => console.error('Erreur PostgreSQL (connexion inactive) :', err.message));

  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  const exec = (sql, args) => (als.getStore() || pool).query(toPg(sql), args);

  const all = async (sql, ...args) => (await exec(sql, args)).rows;
  const one = async (sql, ...args) => (await exec(sql, args)).rows[0] ?? null;
  const run = async (sql, ...args) => ({ changes: (await exec(sql, args)).rowCount });

  async function tx(fn) {
    if (als.getStore()) return fn(); // déjà dans une transaction : on réutilise la même
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [TX_LOCK_KEY]);
      const result = await als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw err;
    } finally { client.release(broken); }
  }

  async function migrate(dir = path.join(__dirname, 'pg')) {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`);
      const files = fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
      let applied = 0;
      for (const f of files) {
        const version = parseInt(f, 10), name = f.replace(/^\d+_/, '').replace(/\.sql$/, '');
        const sql = fs.readFileSync(path.join(dir, f), 'utf8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');
        const done = (await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version])).rows[0];
        if (done) {
          if (done.checksum !== checksum) throw new Error(`Migration ${f} modifiée après application. Créez une nouvelle migration.`);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [version, name, checksum]);
          await client.query('COMMIT');
          applied++;
          console.log(`Migration PostgreSQL ${version} appliquée : ${name}`);
        } catch (err) { await client.query('ROLLBACK'); throw err; }
      }
      return { applied };
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); } catch {}
      client.release();
    }
  }

  return { pool, all, one, run, tx, migrate, close: () => pool.end() };
}

module.exports = { createDb };

if (require.main === module) {
  (async () => {
    const db = createDb(process.env.DATABASE_URL);
    try { const r = await db.migrate(); console.log(r.applied ? 'Schéma PostgreSQL à jour.' : 'Schéma PostgreSQL déjà à jour.'); }
    finally { await db.close(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
