'use strict';

const { query, transaction } = require('../database/pool');
const { parseAmount } = require('../security/money');

const MAX_PAGE = 100;
const METHODS = new Set(['mobile_money', 'bank']);

function validateIdempotencyKey(value) {
  const key = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new TypeError("Clé d'idempotence invalide (8 à 128 caractères).");
  }
  return key;
}

function validateDestination(method, value) {
  if (!METHODS.has(method)) throw new TypeError('Méthode de retrait non prise en charge.');
  const destination = String(value ?? '').trim();
  if (destination.length < 5 || destination.length > 160 || /[\r\n\0]/.test(destination)) {
    throw new TypeError('Destination de retrait invalide.');
  }
  return destination;
}

function pageOptions({ limit = 25, before = null } = {}) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE) {
    throw new RangeError('La limite doit être comprise entre 1 et 100.');
  }
  let cursor = null;
  if (before !== null && before !== undefined && before !== '') {
    cursor = String(before);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(cursor) || Number.isNaN(Date.parse(cursor))) {
      throw new TypeError('Curseur de pagination invalide.');
    }
  }
  return { limit: parsed, before: cursor };
}

async function getWallets(userId) {
  const result = await query(
    `SELECT id, wallet_type, currency, balance, created_at, updated_at
     FROM wallets WHERE user_id=$1 ORDER BY wallet_type`,
    [userId]
  );
  return result.rows.map(row => ({ ...row, balance: String(row.balance) }));
}

async function getTransactions(userId, options = {}) {
  const { limit, before } = pageOptions(options);
  const result = await query(
    `SELECT id, wallet_id, entry_type, amount, currency, reference_type,
            reference_id, description, created_at
     FROM ledger_entries
     WHERE user_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [userId, before, limit]
  );
  return result.rows.map(row => ({ ...row, amount: String(row.amount) }));
}

async function requestWithdrawal(userId, input) {
  const amount = parseAmount(input.amount, { min: 100, max: 1000000000 });
  const method = String(input.method ?? '');
  const destination = validateDestination(method, input.destination);
  const key = validateIdempotencyKey(input.idempotencyKey);
  const withdrawalKey = `withdrawal:${userId}:${key}`;
  const ledgerKey = `withdrawal-hold:${userId}:${key}`;

  return transaction(async tx => {
    const existing = await tx.query(
      `SELECT id, amount, status, method, destination, created_at
       FROM withdrawals WHERE idempotency_key=$1`,
      [withdrawalKey]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (String(row.amount) !== String(amount) || row.method !== method || row.destination !== destination) {
        const error = new Error("Cette clé d'idempotence a déjà été utilisée avec d'autres paramètres.");
        error.status = 409;
        throw error;
      }
      return { ...row, amount: String(row.amount), replayed: true };
    }

    const walletResult = await tx.query(
      `SELECT id, balance FROM wallets
       WHERE user_id=$1 AND wallet_type='earnings' AND currency='XOF'
       FOR UPDATE`,
      [userId]
    );
    if (!walletResult.rowCount) {
      const error = new Error('Portefeuille de gains introuvable.');
      error.status = 404;
      throw error;
    }
    const wallet = walletResult.rows[0];
    const concurrent = await tx.query(
      `SELECT id, amount, status, method, destination, created_at
       FROM withdrawals WHERE idempotency_key=$1`,
      [withdrawalKey]
    );
    if (concurrent.rowCount) {
      const row = concurrent.rows[0];
      if (String(row.amount) !== String(amount) || row.method !== method || row.destination !== destination) {
        const error = new Error("Cette clé d'idempotence a déjà été utilisée avec d'autres paramètres.");
        error.status = 409;
        throw error;
      }
      return { ...row, amount: String(row.amount), replayed: true };
    }
    const balance = BigInt(wallet.balance);
    if (balance < BigInt(amount)) {
      const error = new Error('Solde disponible insuffisant.');
      error.status = 409;
      throw error;
    }

    const created = await tx.query(
      `INSERT INTO withdrawals(user_id,wallet_id,amount,method,destination,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id, amount, status, method, destination, created_at`,
      [userId, wallet.id, amount, method, destination, withdrawalKey]
    );
    await tx.query('UPDATE wallets SET balance=balance-$1, updated_at=now() WHERE id=$2', [amount, wallet.id]);
    await tx.query(
      `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
       VALUES($1,$2,'withdrawal_hold',$3,'XOF','withdrawal',$4,$5,'Montant réservé pour une demande de retrait')`,
      [wallet.id, userId, -amount, created.rows[0].id, ledgerKey]
    );
    return { ...created.rows[0], amount: String(created.rows[0].amount), replayed: false };
  });
}

module.exports = {
  getWallets, getTransactions, requestWithdrawal,
  validateIdempotencyKey, validateDestination, pageOptions
};
