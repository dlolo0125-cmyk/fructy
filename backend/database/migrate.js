'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getPool, closePool } = require('./pool');

const MIGRATION_LOCK = 'fructy-v12-schema-migrations';

async function migrate() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const directory = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      const name = file.slice(4, -4);
      const sql = fs.readFileSync(path.join(directory, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum.trim() !== checksum) throw new Error(`Migration ${file} modifiée après application. Ajouter une nouvelle migration.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)', [version, name, checksum]);
        await client.query('COMMIT');
        console.log(`Migration V12 appliquée: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied: files.length };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]); } catch {}
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => console.log('Schéma PostgreSQL V12 vérifié.'))
    .catch(error => { console.error('Échec migration V12:', error.message); process.exitCode = 1; })
    .finally(closePool);
}
module.exports = { migrate };
