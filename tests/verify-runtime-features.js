'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sikaplus-runtime-'));
const port = 32000 + Math.floor(Math.random() * 10000);
const adminPhone = '22890000002', adminPassword = 'AdminTestPass123!';
const env = { ...process.env, DATA_DIR: dir, PORT: String(port), SECRET: 'runtime-test-secret-'.repeat(4), CHARIOW_PRODUCT_ID:'prd_qc1stvd5', CHARIOW_PULSE_SECRET:'pulse-test-secret-'.repeat(3), ADMIN_PHONE: adminPhone, ADMIN_PASSWORD: adminPassword };
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore','pipe','pipe'] });
let logs = '';
child.stdout.on('data', b => logs += b.toString());
child.stderr.on('data', b => logs += b.toString());
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady() {
  for (let i=0;i<80;i++) { try { const r=await fetch(base); if(r.status===200||r.status===404)return; } catch {} await sleep(100); }
  throw new Error('Serveur de test non démarré. '+logs);
}
async function req(route, token, body) {
  const r = await fetch(base+route, { method: body===undefined?'GET':'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}, body:body===undefined?undefined:JSON.stringify(body) });
  const type=r.headers.get('content-type')||'';
  return type.includes('application/json') ? {status:r.status,...await r.json()} : {status:r.status,text:await r.text()};
}
function decodeBase32(s) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';
  for(const c of s) bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');
  const out=[];for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out);
}
function totp(secret) {
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const h=crypto.createHmac('sha1',decodeBase32(secret)).update(counter).digest(),offset=h[19]&15;
  return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
(async()=>{
 try {
  await waitReady();
  const adminLogin=await req('/api/admin/login',null,{phone:adminPhone,password:adminPassword});
  assert.equal(adminLogin.status,200,'connexion admin de test');
  const adminVerify=await req('/api/admin/totp',null,{tmp:adminLogin.data.tmp,code:totp(adminLogin.data.secret)});
  assert.equal(adminVerify.status,200,'validation TOTP admin');const adminToken=adminVerify.data.token;

  const product=await req('/api/admin/product',adminToken,{name:'PDF test',sym:'PDF1',price:4000,access_days:2,daily_reward:800,hidden:false,teaser:'Fiche de test',facts:'',body:'',pdf_url:''});
  assert.equal(product.status,200);const productId=product.data;
  const pdfBytes=Buffer.from('%PDF-1.4\n%%EOF');
  const pdfUpload=await req('/api/admin/pdf',adminToken,{id:productId,dataUrl:'data:application/pdf;base64,'+pdfBytes.toString('base64')});
  assert.equal(pdfUpload.status,200,'import PDF privé par l’admin');

  const day=new Date().toISOString().slice(0,10);
  const adminQuestions=await req('/api/admin/list?kind=questions&date='+day,adminToken);assert.equal(adminQuestions.data.length,4,'4 questions tirées automatiquement par jour');assert.equal(new Set(adminQuestions.data.map(x=>x.prompt)).size,4,'4 questions différentes');
  const manual=await req('/api/admin/question',adminToken,{date:day,prompt:'Question manuelle',options:['A','B','C','D'],correct_option:0});assert.equal(manual.status,400,'plus de saisie manuelle');
  const again=await req('/api/admin/list?kind=questions&date='+day,adminToken);assert.deepEqual(again.data.map(x=>x.id),adminQuestions.data.map(x=>x.id),'les 4 questions restent les mêmes toute la journée');

  const reg=await req('/api/register',null,{phone:'22890000001',password:'TestPass123'});
  assert.equal(reg.status,200); const token=reg.data.token;
  const depositOptions=await req('/api/t/deposit_options',token);
  assert.deepEqual(depositOptions.data.map(x=>x.label),['Méthode 1','Méthode 2','Méthode 3','Méthode 4','Méthode 5'],'cinq méthodes de dépôt, sans montants fixes');
  const activate=await req('/api/admin/user',adminToken,{id:reg.data.id,sub:5000,gain:0,vip:0,active:true});assert.equal(activate.status,200);
  const blockedProfile=await req('/api/rpc/update_profile',token,{n:'Nouveau Nom',pn:'Nouveau Prenom',em:'new@example.com',mt:'Flooz',pay:'90000000'});
  assert.equal(blockedProfile.status,400,'un client activé ne peut plus modifier son profil');
  assert.match(blockedProfile.error.message,/sikaplus\.con0125@gmail\.com/,'le message de verrouillage doit indiquer le support');
  const buy=await req('/api/rpc/buy_product',token,{pid:productId});assert.equal(buy.status,200);
  let profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,1800,'premier crédit de 800 F le jour de l’achat');
  let purchases=await req('/api/t/purchases',token);assert.equal(purchases.data.length,1);assert.equal(purchases.data[0].rewards_paid,800);assert.equal(purchases.data[0].active,1);
  const pdfOpen=await fetch(base+'/private-pdf/'+productId,{headers:{Authorization:'Bearer '+token}});assert.equal(pdfOpen.status,200,'le PDF privé doit être accessible pendant la validité');
  const qs=await req('/api/t/daily_questions',token);assert.equal(qs.data.length,4);assert.equal(qs.data[0].correct_option,undefined,'la bonne réponse ne doit pas être exposée');
  const answer=await req('/api/rpc/answer_daily_question',token,{qid:adminQuestions.data[0].id,choice:adminQuestions.data[0].correct_option});assert.equal(answer.status,200);assert.equal(answer.data.correct,true);assert.equal(answer.data.reward,25);
  const duplicate=await req('/api/rpc/answer_daily_question',token,{qid:adminQuestions.data[0].id,choice:adminQuestions.data[0].correct_option});assert.equal(duplicate.status,400,'une question ne peut pas être payée deux fois');
  const wrong=await req('/api/rpc/answer_daily_question',token,{qid:adminQuestions.data[1].id,choice:(adminQuestions.data[1].correct_option+1)%4});assert.equal(wrong.status,200);assert.equal(wrong.data.correct,false);assert.equal(wrong.data.reward,0);
  const third=await req('/api/rpc/answer_daily_question',token,{qid:adminQuestions.data[2].id,choice:adminQuestions.data[2].correct_option});assert.equal(third.data.reward,25);
  profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,1850,'deux bonnes réponses créditent 50 F au portefeuille achat');
  let bonuses=(await req('/api/t/bonuses',token)).data[0];assert.equal(bonuses.purchase_state,'available','achat dans les 5 jours : bonus disponible');assert.equal(bonuses.welcome_claimed,0);
  const welcome=await req('/api/rpc/claim_welcome',token,{});assert.equal(welcome.status,200);assert.equal(welcome.data.amount,200);
  assert.equal((await req('/api/rpc/claim_welcome',token,{})).status,400,'cadeau de bienvenue une seule fois');
  const pb=await req('/api/rpc/claim_purchase_bonus',token,{});assert.equal(pb.status,200);assert.equal(pb.data.amount,300);
  assert.equal((await req('/api/rpc/claim_purchase_bonus',token,{})).status,400,'bonus achat une seule fois');
  profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,2350,'200 F + 300 F ajoutés');
  const reg2=await req('/api/register',null,{phone:'22890000077',password:'TestPass123'});const token2=reg2.data.token;
  await req('/api/admin/user',adminToken,{id:reg2.data.id,sub:0,gain:0,vip:0,active:true});
  assert.equal((await req('/api/t/bonuses',token2)).data[0].purchase_state,'locked','sans achat : bonus verrouillé');
  assert.equal((await req('/api/rpc/claim_purchase_bonus',token2,{})).status,400,'bonus refusé sans achat');
  const adminPurchases=await req('/api/admin/list?kind=purchases',adminToken);assert.equal(adminPurchases.data.length,1,'l’admin voit les achats clients');

  // Vérification du webhook Chariow : signature, montant XOF, crédit unique.
  const chariowOrder='order-test-'+Date.now(),depositRef='chariow:'+chariowOrder;
  const dbOrder=new DatabaseSync(path.join(dir,'sikaplus.db'));
  dbOrder.prepare('INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES(?,?,?,?,?)').run(chariowOrder,reg.data.id,1000,'prd_qc1stvd5',depositRef);
  dbOrder.prepare('INSERT INTO deposits(id,user_id,amount,ref,status) VALUES(?,?,?,?,?)').run('dep-'+chariowOrder,reg.data.id,1000,depositRef,'attente');dbOrder.close();
  const pulse={event:'successful.sale',sale:{id:'sale-'+chariowOrder,status:'completed',amount:{value:1000,currency:'XOF'},custom_metadata:{sikaplus_order_id:chariowOrder,sikaplus_user_id:reg.data.id,sikaplus_amount:'1000'}},product:{id:'prd_qc1stvd5'}};
  const rawPulse=JSON.stringify(pulse),pulseSig='sha256='+crypto.createHmac('sha256',env.CHARIOW_PULSE_SECRET).update(rawPulse).digest('hex');
  const pulseHeaders={'Content-Type':'application/json','x-chariow-signature':pulseSig,'x-pulse-delivery-id':'delivery-'+chariowOrder,'x-pulse-event':'successful.sale'};
  let pulseRes=await fetch(base+'/webhooks/chariow',{method:'POST',headers:pulseHeaders,body:rawPulse});assert.equal(pulseRes.status,200,'Pulse Chariow signé accepté');
  pulseRes=await fetch(base+'/webhooks/chariow',{method:'POST',headers:pulseHeaders,body:rawPulse});assert.equal(pulseRes.status,200,'Pulse rejoué accepté sans double crédit');
  profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,3350,'un dépôt Chariow validé ajoute exactement 1 000 F une seule fois');
  const order2000='order-2000-'+Date.now(),ref2000='chariow:'+order2000;
  const db2000=new DatabaseSync(path.join(dir,'sikaplus.db'));
  db2000.prepare('INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES(?,?,?,?,?)').run(order2000,reg.data.id,2000,'prd_yl93dwer',ref2000);
  db2000.prepare('INSERT INTO deposits(id,user_id,amount,ref,status) VALUES(?,?,?,?,?)').run('dep-'+order2000,reg.data.id,2000,ref2000,'attente');db2000.close();
  const blockedManual=await req('/api/admin/decide',adminToken,{kind:'deposit',id:'dep-'+order2000,ok:true});assert.equal(blockedManual.status,400,'un dépôt Chariow ne peut pas être validé manuellement');assert.match(blockedManual.error.message,/traité automatiquement/);
  const pulse2000={event:'successful.sale',sale:{id:'sale-'+order2000,status:'completed',amount:{value:2000,currency:'XOF'},custom_metadata:{sikaplus_order_id:order2000,sikaplus_user_id:reg.data.id,sikaplus_amount:'2000'}},product:{id:'prd_yl93dwer'}};
  const raw2000=JSON.stringify(pulse2000),sig2000='sha256='+crypto.createHmac('sha256',env.CHARIOW_PULSE_SECRET).update(raw2000).digest('hex');
  const res2000=await fetch(base+'/webhooks/chariow',{method:'POST',headers:{...pulseHeaders,'x-chariow-signature':sig2000,'x-pulse-delivery-id':'delivery-'+order2000},body:raw2000});assert.equal(res2000.status,200,'Pulse signé du produit 2 000 FCFA accepté');
  profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,5350,'un dépôt de 2 000 F est crédité une seule fois');
  const mismatchOrder='order-mismatch-'+Date.now(),mismatchRef='chariow:'+mismatchOrder;
  const dbMismatch=new DatabaseSync(path.join(dir,'sikaplus.db'));dbMismatch.prepare('INSERT INTO chariow_orders(id,user_id,amount,product_id,deposit_ref) VALUES(?,?,?,?,?)').run(mismatchOrder,reg.data.id,1000,'prd_qc1stvd5',mismatchRef);dbMismatch.prepare('INSERT INTO deposits(id,user_id,amount,ref,status) VALUES(?,?,?,?,?)').run('dep-'+mismatchOrder,reg.data.id,1000,mismatchRef,'attente');dbMismatch.close();
  const badMeta={event:'successful.sale',sale:{id:'sale-'+mismatchOrder,status:'completed',amount:{value:1000,currency:'XOF'},custom_metadata:{sikaplus_order_id:mismatchOrder,sikaplus_user_id:'wrong-user',sikaplus_amount:'1000'}},product:{id:'prd_qc1stvd5'}};
  const badRaw=JSON.stringify(badMeta),badSig='sha256='+crypto.createHmac('sha256',env.CHARIOW_PULSE_SECRET).update(badRaw).digest('hex');
  const beforeBad=(await req('/api/t/profiles',token)).data[0].wallet_sub;const badRes=await fetch(base+'/webhooks/chariow',{method:'POST',headers:{...pulseHeaders,'x-chariow-signature':badSig,'x-pulse-delivery-id':'delivery-'+mismatchOrder},body:badRaw});assert.equal(badRes.status,200,'une notification signée mais avec un mauvais utilisateur est ignorée');
  const afterBad=(await req('/api/t/profiles',token)).data[0].wallet_sub;assert.equal(afterBad,beforeBad,'une métadonnée utilisateur incorrecte ne crédite aucun compte');
  const invalidPulse=await fetch(base+'/webhooks/chariow',{method:'POST',headers:{...pulseHeaders,'x-pulse-delivery-id':'invalid-'+chariowOrder,'x-chariow-signature':'sha256=bad'},body:rawPulse});assert.equal(invalidPulse.status,401,'signature Pulse invalide refusée');

  const db=new DatabaseSync(path.join(dir,'sikaplus.db'));
  db.prepare("UPDATE product_accesses SET purchased_at=?,expires_at=? WHERE user_id=? AND product_id=?").run(new Date(Date.now()-25*3600000).toISOString(),new Date(Date.now()+23*3600000).toISOString(),reg.data.id,productId);
  db.close();
  profile=await req('/api/t/profiles',token);assert.equal(profile.data[0].wallet_sub,6150,'deuxième crédit de 800 F après 24 heures');
  const db2=new DatabaseSync(path.join(dir,'sikaplus.db'));
  db2.prepare("UPDATE product_accesses SET expires_at=? WHERE user_id=? AND product_id=?").run(new Date(Date.now()-1000).toISOString(),reg.data.id,productId);
  db2.close();
  const content=await req('/api/t/product_content',token);assert.equal(content.data.length,0,'un PDF expiré ne doit plus apparaître comme accessible');
  const pdfExpired=await fetch(base+'/private-pdf/'+productId,{headers:{Authorization:'Bearer '+token}});assert.equal(pdfExpired.status,403,'un PDF privé expiré doit être bloqué côté serveur');
  const tooRich=await req('/api/admin/product',adminToken,{id:productId,name:'PDF test',sym:'PDF1',price:4000,access_days:2,daily_reward:1500,hidden:false,teaser:'',facts:'',body:'',pdf_url:''});assert.equal(tooRich.status,400,'des crédits supérieurs à 50 % du prix doivent être refusés');
  const topup=await req('/api/admin/user',adminToken,{id:reg.data.id,sub:5000,gain:0,vip:0,active:true});assert.equal(topup.status,200);
  const dbA=new DatabaseSync(path.join(dir,'sikaplus.db'));const audits=dbA.prepare("SELECT action FROM admin_audit_logs").all().map(r=>r.action);const adj=dbA.prepare("SELECT amount FROM ledger WHERE user_id=? AND kind='ajustement_achat'").all(reg.data.id);dbA.close();
  assert.ok(audits.includes('user_adjust')&&audits.includes('product_save'),'les actions admin sensibles doivent être journalisées');assert.ok(adj.length>=1,'un ajustement de solde doit laisser une écriture au ledger');
  const rebuy=await req('/api/rpc/buy_product',token,{pid:productId});assert.equal(rebuy.status,200,'un produit expiré peut être racheté');
  const manualRef='manual-test-'+Date.now(),manualId='manual-dep-'+Date.now();const dbManual=new DatabaseSync(path.join(dir,'sikaplus.db'));const walletBeforeManual=dbManual.prepare('SELECT wallet_sub FROM profiles WHERE id=?').get(reg.data.id).wallet_sub;dbManual.prepare('INSERT INTO deposits(id,user_id,amount,ref,status) VALUES(?,?,?,?,?)').run(manualId,reg.data.id,500,manualRef,'attente');dbManual.close();
  const manualApproved=await req('/api/admin/decide',adminToken,{kind:'deposit',id:manualId,ok:true});assert.equal(manualApproved.status,200,'un dépôt manuel conserve sa validation par l’administrateur');
  const dbFinal=new DatabaseSync(path.join(dir,'sikaplus.db'));const finalWallet=dbFinal.prepare('SELECT wallet_sub FROM profiles WHERE id=?').get(reg.data.id).wallet_sub;const pulseAudit=dbFinal.prepare("SELECT count(*) n FROM admin_audit_logs WHERE action='chariow_auto_credit'").get().n;const pulseOutcome=dbFinal.prepare("SELECT outcome FROM chariow_pulse_deliveries WHERE order_id=?").get(chariowOrder).outcome;dbFinal.close();
  assert.equal(finalWallet-walletBeforeManual,500,'un dépôt manuel approuvé ajoute exactement son montant au portefeuille');assert.ok(pulseAudit>=2,'les crédits Chariow automatiques sont audités');assert.equal(pulseOutcome,'credited','la notification acceptée est tracée comme créditée');
  console.log('Tests runtime réussis : dépôts 1 000 à 20 000 FCFA, verrouillage du profil activé, administration, PDF privés, achats, crédits, quiz, expiration, rachat et webhooks Chariow signés/idempotents pour 1 000 et 2 000 FCFA.');
 } catch(e) { console.error(e); console.error(logs); process.exitCode=1; }
 finally { child.kill('SIGTERM'); await sleep(150); fs.rmSync(dir,{recursive:true,force:true}); }
})();
