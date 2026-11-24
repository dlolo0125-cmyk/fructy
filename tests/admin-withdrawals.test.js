'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWithdrawalReview } = require('../backend/wallet/service');

const id = '123e4567-e89b-12d3-a456-426614174000';

test('valide une approbation sans note', () => {
  assert.deepEqual(validateWithdrawalReview(id, 'approve'), { id, decision: 'approve', note: '' });
});
test('exige une justification pour un refus', () => {
  assert.throws(() => validateWithdrawalReview(id, 'reject', ''), /justification/);
});
test('rejette un identifiant et une décision invalides', () => {
  assert.throws(() => validateWithdrawalReview('abc', 'approve'), /Identifiant/);
  assert.throws(() => validateWithdrawalReview(id, 'pay'), /Décision/);
});
test('limite la note administrative à 500 caractères', () => {
  assert.throws(() => validateWithdrawalReview(id, 'reject', 'x'.repeat(501)), /500/);
});
