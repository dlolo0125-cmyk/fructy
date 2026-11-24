'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { transaction, closePool } = require('./database/pool');
const { normalizePhone, validatePassword } = require('./auth/service');

const scrypt = promisify(crypto.scrypt);

async function main() {
  const phone = normalizePhone(process.env.ADMIN_PHONE);
  const password = validatePassword(process.env.ADMIN_PASSWORD);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
  const created = await transaction(async tx => {
    // Serialise simultaneous bootstrap attempts; never overwrite an existing administrator.
    await tx.query('SELECT pg_advisory_xact_lock(7712012)');
    const existing = await tx.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (existing.rowCount) return false;
    const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    const user = await tx.query(
      `INSERT INTO users(phone,password_hash,role,status,referral_code)
       VALUES($1,$2,'admin','active',$3) RETURNING id`,
      [phone, passwordHash, referralCode]
    );
    await tx.query(
      `INSERT INTO wallets(user_id,wallet_type,currency)
       VALUES($1,'deposit','XOF'),($1,'earnings','XOF')`,
      [user.rows[0].id]
    );
    return true;
  });
  console.log(created
    ? 'Compte administrateur initial créé. Conserve les identifiants dans un gestionnaire sécurisé.'
    : 'Un administrateur existe déjà : aucune modification effectuée.');
}

main().catch(error => {
  console.error('[bootstrap-admin]', error.message);
  process.exitCode = 1;
}).finally(async () => {
  try { await closePool(); } catch { process.exitCode = 1; }
});
