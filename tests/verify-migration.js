'use strict';
// Contrôle de santé d'une base PostgreSQL de production : node --env-file-if-exists=.env tests/verify-migration.js
const { createDb } = require('../backend/database/pg');
const required = ['profiles','products','purchases','deposits','withdrawals','ledger','task_log','announcements','schema_migrations',
  'product_accesses','product_reward_credits','daily_questions','daily_question_answers','chariow_orders','chariow_pulse_deliveries',
  'saspay_orders','user_bonuses','question_bank','product_files','product_images','app_secrets','admin_audit_logs'];
(async () => {
  const db = createDb(process.env.DATABASE_URL);
  try {
    const have = new Set((await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()")).map(r => r.table_name));
    const missing = required.filter(t => !have.has(t));
    if (missing.length) throw new Error('Tables absentes : ' + missing.join(', '));
    const mig = await db.all('SELECT version,name FROM schema_migrations ORDER BY version');
    console.log('Migrations :', mig.map(m => `${m.version} (${m.name})`).join(', '));
    for (const t of ['profiles','products','purchases','deposits','withdrawals','ledger','product_accesses','product_files','product_images'])
      console.log(`${t.padEnd(18)} ${(await db.one(`SELECT count(*) n FROM ${t}`)).n}`);
    const w = await db.one('SELECT COALESCE(SUM(wallet_sub),0) a, COALESCE(SUM(wallet_gain),0) g FROM profiles');
    console.log(`Soldes cumulés : achat=${w.a} gains=${w.g}`);
    const neg = await db.one('SELECT count(*) n FROM profiles WHERE wallet_sub<0 OR wallet_gain<0');
    if (neg.n) throw new Error('Soldes négatifs détectés');
    console.log('Vérification PostgreSQL réussie.');
  } finally { await db.close(); }
})().catch(e => { console.error('✖', e.message); process.exit(1); });
