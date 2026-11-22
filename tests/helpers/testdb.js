'use strict';
// Crée une base PostgreSQL jetable pour chaque test (jamais votre base Neon de production).
// Variable : TEST_DATABASE_URL = chaîne de connexion d'un PostgreSQL local de test (défaut : postgres local standard).
const { Client, types } = require('pg');
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1700, v => Number(v));
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/postgres';
const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

async function createTestDatabase() {
  const name = 'fruty_t_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL); u.pathname = '/' + name;
  const url = u.toString();
  const client = new Client({ connectionString: url });
  await client.connect();
  const q = (sql, args) => client.query(toPg(sql), args);
  return {
    url,
    run: (sql, ...a) => q(sql, a),
    all: async (sql, ...a) => (await q(sql, a)).rows,
    get: async (sql, ...a) => (await q(sql, a)).rows[0] ?? null,
    async drop() {
      try { await client.end(); } catch {}
      const a = new Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    }
  };
}
module.exports = { createTestDatabase };
