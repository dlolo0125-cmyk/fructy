'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = new DatabaseSync(path.join(dataDir, 'sikaplus.db'), { readOnly: true });
const required = [
  'profiles','products','purchases','deposits','withdrawals','ledger','task_log','announcements',
  'schema_migrations','course_categories','courses','course_modules','lessons','payments',
  'payment_events','enrollments','lesson_progress','quizzes','quiz_questions','quiz_attempts',
  'certificates','reward_campaigns','reward_claims','referral_rewards','notifications','admin_audit_logs',
  'product_accesses','product_reward_credits','daily_questions','daily_question_answers','chariow_orders','chariow_pulse_deliveries','saspay_orders'
];
try {
  const missing = required.filter(name => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (missing.length) throw new Error(`Tables absentes : ${missing.join(', ')}`);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) throw new Error(`Violations de clés étrangères : ${JSON.stringify(fk)}`);
  const migrations = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  if (migrations.length < 7 || migrations.at(-1).version !== 7) throw new Error('Migration 007 non enregistrée.');
  console.log('Vérification SikaPlus V6.1 réussie.');
  console.log(`Migrations : ${migrations.map(x => `${x.version} (${x.name})`).join(', ')}`);
  console.log(`Comptes V1 : ${db.prepare('SELECT count(*) n FROM profiles').get().n}`);
  console.log(`Produits V1 : ${db.prepare('SELECT count(*) n FROM products').get().n}`);
  console.log(`Catégories : ${db.prepare('SELECT count(*) n FROM course_categories').get().n}`);
} finally { db.close(); }
