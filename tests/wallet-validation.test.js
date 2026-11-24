'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateIdempotencyKey, validateDestination, pageOptions } = require('../backend/wallet/service');

test('clé idempotence accepte une clé opaque bornée', () => {
  assert.equal(validateIdempotencyKey('order-2026-000001'), 'order-2026-000001');
  assert.throws(() => validateIdempotencyKey('short'), /idempotence/);
  assert.throws(() => validateIdempotencyKey('x'.repeat(129)), /idempotence/);
});

test('destination de retrait est validée selon la méthode', () => {
  assert.equal(validateDestination('mobile_money', '+22890123456'), '+22890123456');
  assert.throws(() => validateDestination('crypto', 'wallet-destination'), /non prise en charge/);
  assert.throws(() => validateDestination('bank', 'abc'), /Destination/);
});

test('pagination limite les volumes et valide le curseur', () => {
  assert.deepEqual(pageOptions({ limit: 50 }), { limit: 50, before: null });
  assert.throws(() => pageOptions({ limit: 101 }), /comprise/);
  assert.throws(() => pageOptions({ before: 'not-a-date' }), /curseur/);
});
