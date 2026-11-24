'use strict';

const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

const transactionContext = new AsyncLocalStorage();
let pool;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL est obligatoire pour Fructy V12.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Math.min(Math.max(Number(process.env.PG_POOL_MAX) || 8, 1), 20),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: 'fructy-v12'
  });
  pool.on('error', error => {
    // Ne jamais journaliser la chaîne de connexion ni les paramètres SQL.
    console.error('[postgres] connexion inactive en erreur:', error.message);
  });
  return pool;
}

function executor() {
  return transactionContext.getStore() || getPool();
}

async function query(text, values = []) {
  if (typeof text !== 'string' || !Array.isArray(values)) {
    throw new TypeError('Requête SQL ou paramètres invalides.');
  }
  return executor().query(text, values);
}

async function transaction(callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('callback requis');
  const active = transactionContext.getStore();
  if (active) return callback({ query: (sql, values = []) => active.query(sql, values) });

  const client = await getPool().connect();
  let reusable = true;
  try {
    await client.query('BEGIN');
    if (options.isolation === 'serializable') {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    }
    if (options.readOnly === true) await client.query('SET TRANSACTION READ ONLY');
    const result = await transactionContext.run(client, () =>
      callback({ query: (sql, values = []) => client.query(sql, values) })
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { reusable = false; }
    throw error;
  } finally {
    client.release(!reusable);
  }
}

async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

module.exports = { getPool, query, transaction, closePool };
