'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSelectedOption } = require('../backend/engagement/service');

test('accepts only integer option indexes from zero to three', () => {
  for (const value of [0, 1, 2, 3]) assert.equal(validateSelectedOption(value), value);
});
test('rejects missing, string, fractional and out-of-range options', () => {
  for (const value of [undefined, null, '0', 1.5, -1, 4, NaN]) {
    assert.throws(() => validateSelectedOption(value), /Réponse invalide/);
  }
});
