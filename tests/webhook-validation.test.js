'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhookSignature } = require('../backend/wallet/service');

test('signature HMAC SHA-256 accepte le corps exact', () => {
  const secret = 'test-secret-for-fructy-only';
  process.env.SASPAY_WEBHOOK_SECRET = secret;
  const body = Buffer.from('{"event_id":"evt_123","event_type":"payment.succeeded"}');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature('saspay', body, signature), true);
  assert.equal(verifyWebhookSignature('saspay', body, `sha256=${signature}`), true);
  assert.equal(verifyWebhookSignature('saspay', Buffer.from(body.toString() + ' '), signature), false);
  delete process.env.SASPAY_WEBHOOK_SECRET;
});

test('signature refuse format incorrect et prestataire inconnu', () => {
  process.env.CHARIOW_WEBHOOK_SECRET = 'another-test-secret';
  assert.equal(verifyWebhookSignature('chariow', Buffer.from('{}'), 'bad'), false);
  assert.throws(() => verifyWebhookSignature('unknown', Buffer.from('{}'), 'a'.repeat(64)), /non pris en charge/);
  delete process.env.CHARIOW_WEBHOOK_SECRET;
});

test('signature échoue proprement si le secret est absent', () => {
  delete process.env.SASPAY_WEBHOOK_SECRET;
  assert.throws(() => verifyWebhookSignature('saspay', Buffer.from('{}'), 'a'.repeat(64)), error => error.status === 503);
});
