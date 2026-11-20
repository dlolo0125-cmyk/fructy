'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../backend/database/migrate');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sikaplus-v22-'));
const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
try {
  db.exec(`CREATE TABLE profiles(id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL);
    CREATE TABLE products(id TEXT PRIMARY KEY, sym TEXT NOT NULL, name TEXT NOT NULL, color TEXT, price INTEGER, teaser TEXT, image_url TEXT, hidden INTEGER DEFAULT 0, pos INTEGER DEFAULT 0, facts TEXT, body TEXT, pdf_url TEXT);
    CREATE TABLE purchases(user_id TEXT, product_id TEXT, price INTEGER, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(user_id,product_id));
    INSERT INTO profiles(id,phone) VALUES('u1','22890000000');
    INSERT INTO products(id,sym,name,price) VALUES('p1','PDF1','PDF historique',4000);
    INSERT INTO purchases(user_id,product_id,price) VALUES('u1','p1',4000);`);
  const result = applyMigrations(db, dir);
  assert.equal(result.version, 7);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chariow_orders'").get(), 'les commandes Chariow doivent être créées');
  assert.ok(db.prepare('SELECT amount FROM deposit_options WHERE amount=1000').get(), 'le dépôt Chariow de 1 000 F doit être proposé');
  const old = db.prepare('SELECT * FROM product_accesses WHERE user_id=? AND product_id=?').get('u1','p1');
  assert.ok(old, 'un achat historique doit être repris');
  assert.equal(old.access_days, 0, 'un ancien achat reste sans expiration');
  assert.equal(old.expires_at, null);
  db.prepare('UPDATE products SET access_days=?,daily_reward=? WHERE id=?').run(2,800,'p1');
  const p = db.prepare('SELECT access_days,daily_reward FROM products WHERE id=?').get('p1');
  assert.equal(p.access_days, 2);
  assert.equal(p.daily_reward, 800);
  const cols = db.prepare("PRAGMA table_info('daily_questions')").all().map(x=>x.name);
  assert.ok(cols.includes('correct_option'));
  // Une base déjà migrée en V3 conserve ses anciennes commandes Chariow à 4 000 F.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sikaplus-v3-legacy-'));
  const legacy = new DatabaseSync(path.join(legacyDir, 'legacy.sqlite'));
  try {
    legacy.exec(`CREATE TABLE profiles(id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL);
      INSERT INTO profiles(id,phone) VALUES('legacy-user','22890000009');
      CREATE TABLE deposit_options(amount INTEGER PRIMARY KEY,label TEXT,pay_url TEXT);
      CREATE TABLE chariow_orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES profiles(id),amount INTEGER NOT NULL CHECK(amount=4000),product_id TEXT NOT NULL,sale_id TEXT UNIQUE,transaction_id TEXT,status TEXT NOT NULL DEFAULT 'pending',deposit_ref TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT);
      CREATE TABLE chariow_pulse_deliveries(delivery_id TEXT PRIMARY KEY,event_name TEXT NOT NULL,received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL);
      INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES('old-order','legacy-user',4000,'old-product','old-ref');`);
    for (const [version,name,file] of [[1,'learning_platform','001_learning_platform.sql'],[2,'product_access_rewards_daily_questions','002_product_access_rewards_daily_questions.sql'],[3,'chariow_deposits','003_chariow_deposits.sql']]) {
      const sql = fs.readFileSync(path.join(__dirname,'..','backend','database','migrations',file),'utf8');
      legacy.prepare('INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)').run(version,name,crypto.createHash('sha256').update(sql).digest('hex'));
    }
    const upgraded = applyMigrations(legacy, legacyDir);
    assert.equal(upgraded.version,7);
    assert.equal(legacy.prepare('SELECT amount FROM chariow_orders WHERE id=?').get('old-order').amount,4000,'une commande Chariow historique doit rester intacte');
    legacy.prepare('INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES(?,?,?,?,?)').run('new-order','legacy-user',1000,'new-product','new-ref');
    assert.equal(legacy.prepare('SELECT amount FROM chariow_orders WHERE id=?').get('new-order').amount,1000,'le nouveau montant Chariow doit être accepté');
  } finally { legacy.close(); fs.rmSync(legacyDir,{recursive:true,force:true}); }
  console.log('Test migration fonctionnelle réussi : ancien achat préservé, paramètres PDF et questions créés.');
} finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
