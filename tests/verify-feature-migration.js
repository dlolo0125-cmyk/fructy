'use strict';
// Vérifie le schéma PostgreSQL : création complète, idempotence, garde-fous d'intégrité et contraintes financières.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDb } = require('../backend/database/pg');
const { createTestDatabase } = require('./helpers/testdb');

(async () => {
  const tdb = await createTestDatabase();
  const db = createDb(tdb.url);
  try {
    const first = await db.migrate();
    assert.equal(first.applied, 2, 'les deux migrations PostgreSQL doivent s’appliquer sur une base vide');
    assert.equal((await db.migrate()).applied, 0, 'relancer les migrations ne doit rien changer');

    const required = ['profiles','products','purchases','deposits','withdrawals','ledger','task_log','announcements','schema_migrations',
      'course_categories','courses','course_modules','lessons','payments','payment_events','enrollments','lesson_progress','quizzes',
      'quiz_questions','quiz_attempts','certificates','reward_campaigns','reward_claims','referral_rewards','notifications','admin_audit_logs',
      'product_accesses','product_reward_credits','daily_questions','daily_question_answers','chariow_orders','chariow_pulse_deliveries',
      'saspay_orders','user_bonuses','question_bank','deposit_options','product_files','product_images','app_secrets'];
    const have = new Set((await tdb.all("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).map(r => r.table_name));
    assert.deepEqual(required.filter(t => !have.has(t)), [], 'toutes les tables doivent exister');

    // Les dates gardent le format texte ISO attendu par le code.
    await tdb.run("INSERT INTO profiles(id,phone,hash,code) VALUES('u1','22890000000','h','C1')");
    const p = await tdb.get("SELECT created_at FROM profiles WHERE id='u1'");
    assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'format de date ISO UTC');
    assert.match((await tdb.get('SELECT fruty_now() n')).n, /Z$/);
    assert.ok((await tdb.get("SELECT fruty_ago(interval '3 minutes') < fruty_now() ok")).ok, 'fruty_ago antérieur à fruty_now');

    // Contraintes : solde jamais négatif, doublons de références, crédits uniques.
    await assert.rejects(tdb.run("UPDATE profiles SET wallet_sub=-1 WHERE id='u1'"), /check/i, 'un solde négatif est impossible');
    await tdb.run("INSERT INTO deposits(id,user_id,amount,ref) VALUES('d1','u1',1000,'ref-1')");
    await assert.rejects(tdb.run("INSERT INTO deposits(id,user_id,amount,ref) VALUES('d2','u1',1000,'ref-1')"), /unique/i, 'référence de dépôt unique');
    await tdb.run("INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES('o1','u1',1000,'p','r1')");
    await assert.rejects(tdb.run("INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES('o2','u1',0,'p','r2')"), /check/i, 'montant Chariow > 0');
    await tdb.run("INSERT INTO products(id,sym,name,price,access_days,daily_reward) VALUES('p1','P','PDF',4000,2,800)");
    await tdb.run("INSERT INTO product_accesses(id,user_id,product_id,price,access_days,daily_reward,expires_at) VALUES('a1','u1','p1',4000,2,800,'2999-01-01T00:00:00.000Z')");
    await assert.rejects(tdb.run("INSERT INTO product_accesses(id,user_id,product_id,price,access_days,daily_reward) VALUES('a2','u1','p1',4000,2,800)"), /check/i, 'un accès limité doit avoir une date d’expiration');
    await tdb.run("INSERT INTO product_reward_credits(id,access_id,user_id,reward_number,amount) VALUES('c1','a1','u1',1,800)");
    await assert.rejects(tdb.run("INSERT INTO product_reward_credits(id,access_id,user_id,reward_number,amount) VALUES('c2','a1','u1',1,800)"), /unique/i, 'un crédit journalier ne peut être versé deux fois');
    const l1 = (await tdb.get("INSERT INTO ledger(user_id,kind,amount) VALUES('u1','t',1) RETURNING id")).id;
    const l2 = (await tdb.get("INSERT INTO ledger(user_id,kind,amount) VALUES('u1','t',1) RETURNING id")).id;
    assert.equal(l2, l1 + 1, 'le grand livre s’auto-incrémente');

    // Une migration modifiée après application doit être refusée.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fruty-mig-'));
    fs.writeFileSync(path.join(dir, '001_x.sql'), 'SELECT 1;');
    const db2 = createDb(tdb.url);
    try {
      await db2.run('DELETE FROM schema_migrations WHERE version=1'); // repart de zéro pour ce mini-dossier
      await db2.migrate(dir);
      fs.writeFileSync(path.join(dir, '001_x.sql'), 'SELECT 2;');
      await assert.rejects(db2.migrate(dir), /modifiée après application/);
    } finally { await db2.close(); fs.rmSync(dir, { recursive: true, force: true }); }

    console.log('Test schéma PostgreSQL réussi : tables, dates ISO, contraintes financières, idempotence et garde-fou de migration.');
  } finally { await db.close(); await tdb.drop(); }
})().catch(e => { console.error(e); process.exit(1); });
