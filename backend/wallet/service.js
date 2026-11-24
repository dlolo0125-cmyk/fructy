'use strict';

const crypto = require('node:crypto');
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

async function createDepositIntent(userId, input) {
  const amount = parseAmount(input.amount, { min: 100, max: 1000000000 });
  const provider = String(input.provider ?? '');
  if (!['saspay', 'chariow'].includes(provider)) {
    throw new TypeError('Prestataire de dépôt non pris en charge.');
  }
  const key = validateIdempotencyKey(input.idempotencyKey);
  const payerPhone = input.payerPhone == null || input.payerPhone === ''
    ? null
    : require('../auth/service').normalizePhone(input.payerPhone);
  const idempotencyKey = `deposit:${userId}:${key}`;

  const result = await query(
    `INSERT INTO payment_intents(user_id,provider,idempotency_key,amount,currency,payer_phone)
     VALUES($1,$2,$3,$4,'XOF',$5)
     ON CONFLICT(idempotency_key) DO NOTHING
     RETURNING id,provider,amount,currency,status,payer_phone,created_at`,
    [userId, provider, idempotencyKey, amount, payerPhone]
  );
  if (result.rowCount) return { ...result.rows[0], amount: String(result.rows[0].amount), replayed: false };

  const existing = await query(
    `SELECT id,user_id,provider,amount,currency,status,payer_phone,created_at
     FROM payment_intents WHERE idempotency_key=$1`,
    [idempotencyKey]
  );
  if (!existing.rowCount) {
    const error = new Error('Impossible de confirmer la création du dépôt. Réessaie avec la même clé.');
    error.status = 409;
    throw error;
  }
  const row = existing.rows[0];
  if (row.user_id !== userId || row.provider !== provider || String(row.amount) !== String(amount) || row.payer_phone !== payerPhone) {
    const error = new Error("Cette clé d'idempotence a déjà été utilisée avec d'autres paramètres.");
    error.status = 409;
    throw error;
  }
  return { ...row, amount: String(row.amount), replayed: true };
}

function verifyWebhookSignature(provider, rawBody, signature) {
  const envName = provider === 'saspay' ? 'SASPAY_WEBHOOK_SECRET'
    : provider === 'chariow' ? 'CHARIOW_WEBHOOK_SECRET' : null;
  if (!envName) throw new TypeError('Prestataire webhook non pris en charge.');
  const secret = process.env[envName];
  if (!secret) {
    const error = new Error(`Secret webhook manquant : configure ${envName}.`);
    error.status = 503;
    throw error;
  }
  const supplied = String(signature ?? '').replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function processDepositWebhook(provider, rawBody, signature) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 32768) {
    const error = new Error('Corps webhook invalide.');
    error.status = 400;
    throw error;
  }
  if (!verifyWebhookSignature(provider, rawBody, signature)) {
    const error = new Error('Signature webhook invalide.');
    error.status = 401;
    throw error;
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch {
    const error = new Error('JSON webhook invalide.');
    error.status = 400;
    throw error;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    const error = new Error('Événement webhook invalide.');
    error.status = 400;
    throw error;
  }

  const eventId = String(event.event_id ?? '').trim();
  const intentId = String(event.payment_intent_id ?? '').trim();
  const providerReference = String(event.provider_reference ?? '').trim();
  const eventType = String(event.event_type ?? '');
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(eventId) ||
      !/^[0-9a-f-]{36}$/i.test(intentId) ||
      providerReference.length < 1 || providerReference.length > 160 ||
      eventType !== 'payment.succeeded') {
    const error = new Error('Événement de paiement incomplet ou non pris en charge.');
    error.status = 400;
    throw error;
  }
  const amount = parseAmount(event.amount, { min: 100, max: 1000000000 });
  if (event.currency !== 'XOF') {
    const error = new Error('Devise de paiement incorrecte.');
    error.status = 409;
    throw error;
  }

  return transaction(async tx => {
    const inserted = await tx.query(
      `INSERT INTO provider_events(provider,provider_event_id,payment_intent_id,event_type,signature_valid,payload)
       VALUES($1,$2,$3,$4,true,$5::jsonb)
       ON CONFLICT(provider,provider_event_id) DO NOTHING
       RETURNING id`,
      [provider, eventId, intentId, eventType, JSON.stringify({
        event_id: eventId, event_type: eventType, payment_intent_id: intentId,
        provider_reference: providerReference, amount, currency: 'XOF'
      })]
    );
    if (!inserted.rowCount) {
      const prior = await tx.query(
        `SELECT payment_intent_id,event_type FROM provider_events
         WHERE provider=$1 AND provider_event_id=$2`,
        [provider, eventId]
      );
      if (!prior.rowCount || prior.rows[0].payment_intent_id !== intentId || prior.rows[0].event_type !== eventType) {
        const error = new Error("L'identifiant d'événement fournisseur a déjà été utilisé pour un autre paiement.");
        error.status = 409;
        throw error;
      }
      return { accepted: true, replayed: true, credited: false };
    }

    const payment = await tx.query(
      `SELECT id,user_id,provider,provider_reference,amount,currency,status
       FROM payment_intents WHERE id=$1 FOR UPDATE`,
      [intentId]
    );
    if (!payment.rowCount) {
      const error = new Error('Intention de dépôt inconnue.');
      error.status = 404;
      throw error;
    }
    const intent = payment.rows[0];
    if (intent.provider !== provider || String(intent.amount) !== String(amount) || intent.currency !== 'XOF') {
      const error = new Error('Le prestataire, le montant ou la devise ne correspond pas au dépôt.');
      error.status = 409;
      throw error;
    }
    if (intent.status === 'succeeded') {
      if (intent.provider_reference !== providerReference) {
        const error = new Error('Référence fournisseur différente pour un dépôt déjà confirmé.');
        error.status = 409;
        throw error;
      }
      await tx.query('UPDATE provider_events SET processed_at=now() WHERE id=$1', [inserted.rows[0].id]);
      return { accepted: true, replayed: false, credited: false, alreadySettled: true };
    }
    if (!['pending', 'processing'].includes(intent.status)) {
      const error = new Error('Cette intention de dépôt ne peut plus être confirmée.');
      error.status = 409;
      throw error;
    }
    if (intent.provider_reference && intent.provider_reference !== providerReference) {
      const error = new Error('Référence fournisseur incompatible.');
      error.status = 409;
      throw error;
    }

    const walletResult = await tx.query(
      `SELECT id FROM wallets WHERE user_id=$1 AND wallet_type='deposit' AND currency='XOF' FOR UPDATE`,
      [intent.user_id]
    );
    if (!walletResult.rowCount) {
      const error = new Error('Portefeuille de dépôt introuvable.');
      error.status = 500;
      throw error;
    }
    const walletId = walletResult.rows[0].id;
    await tx.query(
      `UPDATE wallets SET balance=balance+$1,updated_at=now() WHERE id=$2`,
      [amount, walletId]
    );
    await tx.query(
      `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
       VALUES($1,$2,'deposit_credit',$3,'XOF','payment_intent',$4,$5,'Dépôt confirmé par webhook signé')`,
      [walletId, intent.user_id, amount, intent.id, `deposit-credit:${intent.id}`]
    );
    await tx.query(
      `UPDATE payment_intents SET status='succeeded',provider_reference=$1,confirmed_at=now()
       WHERE id=$2`,
      [providerReference, intent.id]
    );
    await tx.query('UPDATE provider_events SET processed_at=now() WHERE id=$1', [inserted.rows[0].id]);
    return { accepted: true, replayed: false, credited: true, amount: String(amount), currency: 'XOF' };
  });
}

module.exports = {
  getWallets, getTransactions, requestWithdrawal, createDepositIntent, processDepositWebhook, verifyWebhookSignature,
  validateIdempotencyKey, validateDestination, pageOptions
};
