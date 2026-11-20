'use strict';
// Migrations additives, avec une sauvegarde SQLite cohérente avant chaque nouvelle version.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function backupBeforeMigration(db, dataDir, version) {
  const location = db.location();
  if (!location || location === ':memory:' || !fs.existsSync(location)) return null;
  fs.mkdirSync(dataDir, { recursive: true });
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = path.join(dataDir, `sikaplus-before-migration-${version}-${stamp}.sqlite`);
  let suffix = 1;
  while (fs.existsSync(backup)) backup = path.join(dataDir, `sikaplus-before-migration-${version}-${stamp}-${suffix++}.sqlite`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`Sauvegarde créée avant migration ${version} : ${backup}`);
  return backup;
}

function applyMigrations(db, dataDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const files = [
    { version: 1, name: 'learning_platform', file: '001_learning_platform.sql' },
    { version: 2, name: 'product_access_rewards_daily_questions', file: '002_product_access_rewards_daily_questions.sql' },
    { version: 3, name: 'chariow_deposits', file: '003_chariow_deposits.sql' },
    { version: 4, name: 'chariow_deposit_amount_1000', file: '004_chariow_deposit_amount_1000.sql' },
    { version: 5, name: 'chariow_webhook_integrity', file: '005_chariow_webhook_integrity.sql' },
    { version: 6, name: 'question_bank_bonuses', file: '006_question_bank_bonuses.sql' },
    { version: 7, name: 'saspay_deposits', file: '007_saspay_deposits.sql' }
  ];
  let applied = false;
  for (const item of files) {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', item.file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const done = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(item.version);
    if (done) {
      if (done.checksum !== checksum) throw new Error(`Migration ${item.version} modifiée après application. Créez une nouvelle migration.`);
      continue;
    }
    backupBeforeMigration(db, dataDir, item.version);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)').run(item.version, item.name, checksum);
      db.exec('COMMIT');
      applied = true;
      console.log(`Migration ${item.version} appliquée : ${item.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { applied, version: files.at(-1).version };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'sikaplus.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  try {
    const result = applyMigrations(db, dataDir);
    console.log(result.applied ? 'Migrations SikaPlus appliquées.' : 'Schéma SikaPlus déjà à jour.');
  } finally { db.close(); }
}
module.exports = { applyMigrations };
