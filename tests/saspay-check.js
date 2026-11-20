'use strict';
// Diagnostic SasPay : node --env-file=.env tests/saspay-check.js
const key=(process.env.SASPAY_API_KEY||'').trim();
const base=(process.env.SASPAY_BASE_URL||(key.startsWith('sk_test_')?'https://sandbox-api.saspay.me/api/v1':'https://api.saspay.me/api/v1')).replace(/\/$/,'');
const H={Authorization:'Bearer '+key};
const j=async(u,h)=>{const r=await fetch(u,{headers:h||{},signal:AbortSignal.timeout(20000)});let b=null;try{b=await r.json()}catch{}return {s:r.status,b}};
(async()=>{
 console.log('Clé lue :',key?`${key.slice(0,8)}… (${key.length} caractères)`:'AUCUNE (vérifiez SASPAY_API_KEY dans .env)');
 console.log('Adresse :',base);
 if(!key)return;
 const n=await j(base+'/networks/?page_size=100',H);
 console.log('Test de la clé (GET /networks/) : HTTP',n.s,n.s===200?'→ clé ACCEPTÉE':'→ '+JSON.stringify(n.b).slice(0,200));
 if(n.s!==200)return;
 const pick=b=>{if(Array.isArray(b))return b;if(!b||typeof b!=='object')return [];for(const k of ['results','data','networks','items']){const v=b[k];if(Array.isArray(v))return v;if(v&&typeof v==='object'){const w=pick(v);if(w.length)return w}}return []};
 let all=[],url=base+'/networks/?page_size=100',pg=0;
 while(url&&pg++<10){const r=await j(url,H);all=all.concat(pick(r.b));url=r.b&&typeof r.b.next==='string'?r.b.next:null}
 console.log('Réseaux reçus :',all.length);
 if(!all.length){console.log('Forme de la réponse :',JSON.stringify(n.b).slice(0,400));return}
 const tg=all.filter(x=>/(^|_)tg$|togo|t-?money|flooz|moov/i.test(JSON.stringify(x)));
 console.log('Réseaux Togo / T-Money / Flooz / Moov :');
 (tg.length?tg:[]).forEach(x=>console.log(' -',x.code,'|',x.name||'','| pays:',typeof x.country==='object'?JSON.stringify(x.country):x.country));
 if(!tg.length){console.log(' aucun trouvé. Tous les codes :');console.log(all.map(x=>x.code).join(', '))}
})().catch(e=>console.log('Erreur :',e.message));
