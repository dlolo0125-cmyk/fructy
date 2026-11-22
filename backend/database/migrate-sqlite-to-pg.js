'use strict';
/*
 * Copie les données d'une base SQLite Fruty (sikaplus.db) vers PostgreSQL (Neon).
 *
 * Usage :
 *   DATABASE_URL=... node backend/database/migrate-sqlite-to-pg.js <sikaplus.db> [options]
 *
 * Options :
 *   --dry-run          fait tout (copie + vérifications) puis ANNULE : rien n'est écrit dans PostgreSQL.
 *   --replace          vide d'abord les tables de données de PostgreSQL (sinon le script refuse
 *                      de s'exécuter si PostgreSQL contient déjà des données).
 *   --pdf-dir <dossier>      dossier des PDF privés   (défaut : <dossier de la base>/private-pdfs)
 *   --uploads-dir <dossier>  dossier des images       (défaut : <dossier de la base>/uploads)
 *
 * Sécurité :
 *   - la base SQLite d'origine n'est jamais modifiée : le script travaille sur une copie temporaire ;
 *   - tout est écrit dans UNE transaction PostgreSQL : en cas de moindre écart de comptage ou de
 *     somme (soldes, grand livre), tout est annulé ;
 *   - aucune donnée sensible (mots de passe, chaîne de connexion) n'est affichée.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDb } = require('./pg');

// Ordre compatible avec les clés étrangères.
const TABLES = [
  'profiles', 'products', 'course_categories', 'courses', 'course_modules', 'lessons', 'quizzes', 'quiz_questions',
  'payments', 'enrollments', 'certificates', 'payment_events', 'deposit_options', 'deposits', 'withdrawals',
  'purchases', 'task_log', 'ledger', 'announcements', 'admin_audit_logs', 'chariow_orders', 'chariow_pulse_deliveries',
  'daily_questions', 'daily_question_answers', 'product_accesses', 'product_reward_credits', 'question_bank',
  'quiz_attempts', 'referral_rewards', 'reward_campaigns', 'reward_claims', 'saspay_orders', 'user_bonuses',
  'lesson_progress', 'notifications'
];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function parseArgs(argv) {
  const o = { dryRun: false, replace: false, file: null, pdfDir: null, uploadsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--pdf-dir') o.pdfDir = argv[++i];
    else if (a === '--uploads-dir') o.uploadsDir = argv[++i];
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else throw new Error(`Option inconnue : ${a}`);
  }
  return o;
}

function copySqliteSafely(file) {
  if (!fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fruty-migrate-'));
  const target = path.join(dir, 'copy.db');
  fs.copyFileSync(file, target);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, target + ext);
  const db = new DatabaseSync(target);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, dir };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.file) throw new Error('Indiquez le chemin de la base SQLite. Exemple : npm run migrate:sqlite-to-pg -- data/sikaplus.db --dry-run');
  const baseDir = path.dirname(path.resolve(opt.file));
  const pdfDir = path.resolve(opt.pdfDir || path.join(baseDir, 'private-pdfs'));
  const uploadsDir = path.resolve(opt.uploadsDir || path.join(baseDir, 'uploads'));

  const { db: sqlite, dir: tmp } = copySqliteSafely(opt.file);
  const pg = createDb(process.env.DATABASE_URL);
  const report = [];
  try {
    await pg.migrate();
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7340001)');

      // 1. Garde-fou : PostgreSQL doit être vide (hors tables de référence).
      const existing = [];
      for (const t of TABLES) {
        const n = Number((await client.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
        if (n > 0) existing.push(`${t}=${n}`);
      }
      if (existing.length && !opt.replace) {
        throw new Error('PostgreSQL contient déjà des données (' + existing.join(', ') + '). ' +
          'Utilisez une base Neon vide, ou ajoutez --replace pour la vider volontairement avant la copie.');
      }
      if (existing.length) {
        await client.query(`TRUNCATE ${[...TABLES, 'product_files', 'product_images'].join(', ')} RESTART IDENTITY CASCADE`);
        console.log('⚠ Tables PostgreSQL vidées (--replace).');
      }

      // 2. Copie table par table.
      const sqliteTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      for (const t of TABLES) {
        if (!sqliteTables.has(t)) { report.push({ table: t, source: 0, copied: 0, note: 'absente de SQLite' }); continue; }
        const rows = sqlite.prepare(`SELECT * FROM ${t}`).all();
        if (!rows.length) { report.push({ table: t, source: 0, copied: 0 }); continue; }
        const cols = Object.keys(rows[0]);
        const pgCols = new Set((await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [t])).rows.map(r => r.column_name));
        const unknown = cols.filter(c => !pgCols.has(c));
        if (unknown.length) throw new Error(`Table ${t} : colonnes SQLite inconnues dans PostgreSQL : ${unknown.join(', ')}`);
        const per = Math.max(1, Math.floor(60000 / cols.length));
        let copied = 0;
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per), args = [];
          const values = chunk.map(r => '(' + cols.map(c => { args.push(r[c] === undefined ? null : r[c]); return '$' + args.length; }).join(',') + ')').join(',');
          const overriding = t === 'ledger' ? ' OVERRIDING SYSTEM VALUE' : '';
          await client.query(`INSERT INTO ${t}(${cols.map(c => `"${c}"`).join(',')})${overriding} VALUES ${values}`, args);
          copied += chunk.length;
        }
        report.push({ table: t, source: rows.length, copied });
      }
      await client.query("SELECT setval(pg_get_serial_sequence('ledger','id'), GREATEST((SELECT COALESCE(max(id),0) FROM ledger),1), (SELECT count(*)>0 FROM ledger))");

      // 3. PDF privés et images produits (stockés en base).
      let pdfs = 0, images = 0, skipped = [];
      if (fs.existsSync(pdfDir)) {
        for (const f of fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf'))) {
          const id = f.slice(0, -4), buf = fs.readFileSync(path.join(pdfDir, f));
          const exists = (await client.query('SELECT 1 FROM products WHERE id=$1', [id])).rowCount;
          if (!exists || buf.subarray(0, 5).toString() !== '%PDF-') { skipped.push(f); continue; }
          await client.query('INSERT INTO product_files(product_id,data,size) VALUES($1,$2,$3)', [id, buf, buf.length]);
          pdfs++;
        }
      }
      if (fs.existsSync(uploadsDir)) {
        for (const f of fs.readdirSync(uploadsDir)) {
          const mime = MIME[path.extname(f).toLowerCase()];
          if (!mime || !/^[\w.-]{1,120}$/.test(f)) { skipped.push(f); continue; }
          await client.query('INSERT INTO product_images(filename,mime,data) VALUES($1,$2,$3)', [f, mime, fs.readFileSync(path.join(uploadsDir, f))]);
          images++;
        }
      }

      // 4. Vérifications : comptages, soldes, grand livre, fichiers.
      const problems = [];
      for (const r of report) {
        const n = Number((await client.query(`SELECT count(*) n FROM ${r.table}`)).rows[0].n);
        if (n !== r.source) problems.push(`${r.table} : ${r.source} lignes SQLite, ${n} dans PostgreSQL`);
      }
      const sums = [
        ['profiles', 'wallet_sub'], ['profiles', 'wallet_gain'], ['ledger', 'amount'], ['deposits', 'amount'],
        ['withdrawals', 'amount'], ['product_accesses', 'price'], ['product_reward_credits', 'amount']
      ];
      const checks = [];
      for (const [t, c] of sums) {
        if (!sqliteTables.has(t)) continue;
        const a = Number(sqlite.prepare(`SELECT COALESCE(SUM(${c}),0) s FROM ${t}`).get().s);
        const b = Number((await client.query(`SELECT COALESCE(SUM(${c}),0) s FROM ${t}`)).rows[0].s);
        checks.push({ check: `somme ${t}.${c}`, sqlite: a, postgres: b });
        if (a !== b) problems.push(`somme ${t}.${c} : SQLite ${a} ≠ PostgreSQL ${b}`);
      }
      const nFilesPdf = Number((await client.query('SELECT count(*) n FROM product_files')).rows[0].n);
      if (nFilesPdf !== pdfs) problems.push('nombre de PDF en base incorrect');

      console.log('\nTable'.padEnd(28) + 'SQLite'.padStart(8) + 'Copiées'.padStart(10));
      for (const r of report) console.log(r.table.padEnd(27) + String(r.source).padStart(8) + String(r.copied).padStart(10) + (r.note ? '  (' + r.note + ')' : ''));
      console.log('\nSommes de contrôle');
      for (const c of checks) console.log(`  ${c.check.padEnd(34)} SQLite=${c.sqlite}  PostgreSQL=${c.postgres}  ${c.sqlite === c.postgres ? 'OK' : 'ÉCART'}`);
      console.log(`\nFichiers : ${pdfs} PDF privé(s), ${images} image(s) produit copié(s)` + (skipped.length ? `, ${skipped.length} ignoré(s) (${skipped.join(', ')})` : ''));

      if (problems.length) throw new Error('Vérification échouée, rien n’a été écrit :\n - ' + problems.join('\n - '));
      if (opt.dryRun) {
        await client.query('ROLLBACK');
        console.log('\n✔ SIMULATION RÉUSSIE (--dry-run) : toutes les vérifications passent. Rien n’a été écrit dans PostgreSQL.');
      } else {
        await client.query('COMMIT');
        console.log('\n✔ MIGRATION TERMINÉE : toutes les vérifications passent et les données sont enregistrées dans PostgreSQL.');
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally { client.release(); }
  } finally {
    sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await pg.close();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('\n✖ ' + e.message); process.exit(1); });
}
module.exports = { main };
