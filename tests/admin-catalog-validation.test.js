'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {amountField,intField,slugify,validateProductReward}=require('../backend/admin/service');

test('validates whole XOF amounts without floating point conversion',()=>{
 assert.equal(amountField('9007199254740991','Prix'),'9007199254740991');
 assert.equal(amountField('0','Prix'),'0');
 for(const value of ['-1','1.2','1e3',' 2','']) assert.throws(()=>amountField(value,'Prix'));
});
test('validates bounded integer fields',()=>{
 assert.equal(intField('12','Ordre',0,20),12);
 for(const value of ['1.2','-1','21','abc']) assert.throws(()=>intField(value,'Ordre',0,20));
});
test('normalizes slugs and rejects empty slugs',()=>{
 assert.equal(slugify('Économie & finance'), 'economie-finance');
 assert.throws(()=>slugify('!!!'));
});

test('plafonne la récompense quotidienne à 50 % du prix',()=>{
 assert.equal(validateProductReward('4000','2000'),'2000');
 assert.equal(validateProductReward('4001','2000'),'2000');
 assert.throws(()=>validateProductReward('4000','2001'),/50 %/);
 assert.throws(()=>validateProductReward('0','1'),/50 %/);
});
