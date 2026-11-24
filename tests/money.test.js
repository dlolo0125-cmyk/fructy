'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseAmount,safeEqualText}=require('../backend/security/money');
test('montants entiers bornés',()=>{assert.equal(parseAmount('1000',{min:1000,max:100000}),1000);assert.equal(parseAmount(5000),5000)});
test('formats monétaires ambigus refusés',()=>{for(const v of ['1.5','1,000','-2','01','','1e3',null])assert.throws(()=>parseAmount(v));assert.throws(()=>parseAmount('100001',{min:1000,max:100000}))});
test('comparaison de chaînes secrètes',()=>{assert.equal(safeEqualText('abc','abc'),true);assert.equal(safeEqualText('abc','abd'),false);assert.equal(safeEqualText('a','aa'),false)});
