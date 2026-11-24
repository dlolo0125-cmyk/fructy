'use strict';
function parseAmount(value, { min = 1, max = 1000000000 } = {}) {
 const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
 if (!/^(0|[1-9]\d*)$/.test(raw)) throw new TypeError('Montant entier invalide.');
 const amount = Number(raw);
 if (!Number.isSafeInteger(amount) || amount < min || amount > max) throw new RangeError('Montant hors limites.');
 return amount;
}
function safeEqualText(left,right) {
 const crypto=require('node:crypto'),a=Buffer.from(String(left??'')),b=Buffer.from(String(right??''));
 return a.length===b.length && crypto.timingSafeEqual(a,b);
}
module.exports={parseAmount,safeEqualText};
