'use strict';
// Retraits simultanés : un solde de gains ne peut jamais être dépensé deux fois.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createTestDatabase } = require('./helpers/testdb');
(async () => {
  const tdb = await createTestDatabase(), port = 33000 + Math.floor(Math.random() * 5000), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: tdb.url, PORT: String(port), SECRET: 'concurrency-secret-'.repeat(4) } });
  const post = async (r, t, b) => (await fetch(base + r, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b) })).json();
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).status) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const reg = await post('/api/register', null, { phone: '22890001111', password: 'TestPass123' });
    await tdb.run('UPDATE profiles SET active=1, wallet_gain=1000 WHERE id=?', reg.data.id);
    const res = await Promise.all(Array.from({ length: 10 }, () => post('/api/rpc/request_withdrawal', reg.data.token, { a: 1000, m: 'Flooz', d: '90000000' })));
    assert.equal(res.filter(r => !r.error).length, 1, 'un seul retrait sur 10 simultanés doit réussir');
    const p = await tdb.get('SELECT wallet_gain FROM profiles WHERE id=?', reg.data.id);
    assert.equal(p.wallet_gain, 0);
    assert.equal((await tdb.get('SELECT count(*) n FROM withdrawals')).n, 1);
    console.log('Test concurrence réussi : 10 retraits simultanés → 1 accepté, solde 0, aucun double paiement.');
  } finally { child.kill(); await new Promise(r => setTimeout(r, 200)); await tdb.drop(); }
})().catch(e => { console.error(e); process.exit(1); });
