'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { query, transaction } = require('../database/pool');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new TypeError('Numéro de téléphone invalide. Utilise le format international, par exemple +228XXXXXXXX.');
  return phone;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw new TypeError('Le mot de passe doit contenir entre 10 et 128 caractères.');
  }
  return value;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, saltHex, hashHex] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(saltHex || '') || !/^[a-f0-9]{128}$/.test(hashHex || '')) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function publicUser(row) {
  return {
    id: row.id, phone: row.phone, role: row.role, status: row.status,
    referralCode: row.referral_code, firstName: row.first_name,
    lastName: row.last_name, email: row.email, createdAt: row.created_at
  };
}
function makeToken() { return crypto.randomBytes(32).toString('base64url'); }
function identifierHash(phone, ip) {
  return tokenHash(`${phone}\0${String(ip || '').slice(0, 80)}`);
}

async function register(input) {
  const phone = normalizePhone(input.phone);
  const password = validatePassword(input.password);
  const firstName = String(input.firstName || '').trim().slice(0, 80) || null;
  const lastName = String(input.lastName || '').trim().slice(0, 80) || null;
  const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 254) : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError('Adresse e-mail invalide.');

  const passwordHash = await hashPassword(password);
  const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
  const refCode = input.referralCode ? String(input.referralCode).trim().toUpperCase() : null;
  const user = await transaction(async tx => {
    let inviterId = null;
    if (refCode) {
      const inviter = await tx.query('SELECT id FROM users WHERE referral_code=$1 AND status <> $2', [refCode, 'closed']);
      if (!inviter.rowCount) throw new TypeError('Code de parrainage invalide.');
      inviterId = inviter.rows[0].id;
    }
    const created = await tx.query(
      `INSERT INTO users(phone,password_hash,referral_code,referred_by,first_name,last_name,email)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,phone,role,status,referral_code,first_name,last_name,email,created_at`,
      [phone,passwordHash,referralCode,inviterId,firstName,lastName,email]
    );
    const row = created.rows[0];
    await tx.query(
      `INSERT INTO wallets(user_id,wallet_type,currency) VALUES($1,'deposit','XOF'),($1,'earnings','XOF')`,
      [row.id]
    );
    return row;
  });
  return publicUser(user);
}

async function login(input, ip) {
  const phone = normalizePhone(input.phone);
  const password = validatePassword(input.password);
  const key = identifierHash(phone, ip);
  const attempt = await query('SELECT failed_count,window_started_at,locked_until FROM auth_attempts WHERE identifier_hash=$1', [key]);
  if (attempt.rowCount && attempt.rows[0].locked_until && new Date(attempt.rows[0].locked_until) > new Date()) {
    const error = new Error('Trop de tentatives. Réessaie dans quelques minutes.');
    error.status = 429; throw error;
  }

  const found = await query(
    `SELECT id,phone,password_hash,role,status,referral_code,first_name,last_name,email,created_at
     FROM users WHERE phone=$1`, [phone]
  );
  const valid = found.rowCount ? await verifyPassword(password, found.rows[0].password_hash) : await scrypt(password, Buffer.alloc(16), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).then(() => false);
  if (!valid || found.rows[0].status === 'suspended' || found.rows[0].status === 'closed') {
    await transaction(async tx => {
      await tx.query(
        `INSERT INTO auth_attempts(identifier_hash,failed_count,window_started_at,locked_until)
         VALUES($1,1,now(),NULL)
         ON CONFLICT(identifier_hash) DO UPDATE SET
           failed_count=CASE WHEN auth_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_attempts.failed_count+1 END,
           window_started_at=CASE WHEN auth_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth_attempts.window_started_at END,
           locked_until=CASE WHEN (CASE WHEN auth_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_attempts.failed_count+1 END) >= $2 THEN now()+interval '15 minutes' ELSE NULL END,
           updated_at=now()`,
        [key, MAX_FAILED]
      );
    });
    const error = new Error('Identifiants incorrects ou compte indisponible.');
    error.status = 401; throw error;
  }

  await query('DELETE FROM auth_attempts WHERE identifier_hash=$1', [key]);
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query('INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [found.rows[0].id, tokenHash(token), expiresAt]);
  return { user: publicUser(found.rows[0]), token, expiresAt };
}

async function authenticate(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const result = await query(
    `SELECT u.id,u.phone,u.role,u.status,u.referral_code,u.first_name,u.last_name,u.email,u.created_at
     FROM user_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u.status IN ('active','pending')`,
    [tokenHash(token)]
  );
  return result.rowCount ? publicUser(result.rows[0]) : null;
}

async function logout(token) {
  if (!token) return;
  await query('UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(token)]);
}

module.exports = { register, login, authenticate, logout, normalizePhone, validatePassword };
