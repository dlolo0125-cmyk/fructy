'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizePhone,validatePassword}=require('../backend/auth/service');

test('normalise les numéros internationaux sans modifier leur indicatif',()=>{
 assert.equal(normalizePhone('+228 90 12 34 56'),'+22890123456');
 assert.equal(normalizePhone('+33123456789'),'+33123456789');
});
test('refuse les numéros incomplets ou ambigus',()=>{
 for(const value of ['90123456','0022890123456','+228ABC','+0123456789',''])assert.throws(()=>normalizePhone(value));
});
test('impose une longueur minimale et maximale au mot de passe',()=>{
 assert.equal(validatePassword('motdepasse123'),'motdepasse123');
 for(const value of ['court','',null,'a'.repeat(129)])assert.throws(()=>validatePassword(value));
});
