'use strict';

const { query } = require('../database/pool');
const { pageOptions } = require('../wallet/service');

async function getOverview() {
  const result = await query(`
    SELECT
      (SELECT count(*)::text FROM users) AS users_total,
      (SELECT count(*)::text FROM users WHERE status='active') AS users_active,
      (SELECT count(*)::text FROM users WHERE status='pending') AS users_pending,
      (SELECT count(*)::text FROM withdrawals WHERE status='pending') AS withdrawals_pending,
      (SELECT COALESCE(sum(balance),0)::text FROM wallets WHERE wallet_type='deposit') AS deposits_balance,
      (SELECT COALESCE(sum(balance),0)::text FROM wallets WHERE wallet_type='earnings') AS earnings_balance
  `);
  return result.rows[0];
}

async function listUsers(options = {}) {
  const { limit, before } = pageOptions(options);
  const search = String(options.search ?? '').trim().slice(0, 80);
  const result = await query(
    `SELECT id,phone,role,status,first_name,last_name,email,created_at
     FROM users
     WHERE ($1='' OR phone ILIKE '%' || $1 || '%' OR
       COALESCE(first_name,'') ILIKE '%' || $1 || '%' OR
       COALESCE(last_name,'') ILIKE '%' || $1 || '%')
       AND ($2::timestamptz IS NULL OR created_at<$2)
     ORDER BY created_at DESC,id DESC LIMIT $3`,
    [search, before, limit]
  );
  return result.rows;
}

module.exports = { getOverview, listUsers };
