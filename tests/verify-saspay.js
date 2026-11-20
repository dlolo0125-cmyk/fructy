'use strict';
// Test bout en bout du dépôt SasPay avec un faux serveur SasPay (aucun appel réseau externe).
const http=require('http'),crypto=require('crypto'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const assert=require('assert');
const SECRET='whsec_test',tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fruty-sp-'));
let payStatus='PENDING',lastBody=null,lastKey=null;
const mock=http.createServer((q,r)=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>{r.setHeader('Content-Type','application/json');
 if(q.method==='POST'&&q.url==='/api/v1/payments/softpay/'){lastBody=JSON.parse(d);lastKey=q.headers['idempotency-key'];return r.end(JSON.stringify({success:true,data:{id:'pay-1',status:'PENDING',checkout_url:'',instructions:'Validez sur votre téléphone'},code:201}))}
 if(q.url==='/api/v1/payments/pay-1/verify/')return r.end(JSON.stringify({success:true,data:{id:'pay-1',status:payStatus,requested_amount:'2000.00',net_amount:'2000.00',currency:'XOF'}}));
 r.statusCode=404;r.end('{}')})});
const req=(port,m,p,b,h={})=>new Promise(ok=>{const x=http.request({port,method:m,path:p,headers:{'Content-Type':'application/json',...h}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>ok({s:r.statusCode,j:(()=>{try{return JSON.parse(d)}catch{return d}})()}))});if(b)x.write(typeof b==='string'?b:JSON.stringify(b));x.end()});
const hook=(port,body,{ts=Math.floor(Date.now()/1000),secret=SECRET}={})=>{const raw=JSON.stringify(body),sig=crypto.createHmac('sha256',secret).update(ts+'.'+raw).digest('hex');return req(port,'POST','/webhooks/saspay',raw,{'X-Webhook-Signature':sig,'X-Webhook-Timestamp':String(ts)})};
(async()=>{
 await new Promise(r=>mock.listen(0,r));const mp=mock.address().port,port=3900+Math.floor(Math.random()*90);
 const srv=spawn(process.execPath,['--disable-warning=ExperimentalWarning',path.join(__dirname,'..','server.js')],{env:{...process.env,PORT:port,DATA_DIR:tmp,SASPAY_API_KEY:'sk_test_x',SASPAY_WEBHOOK_SECRET:SECRET,SASPAY_BASE_URL:'http://127.0.0.1:'+mp+'/api/v1',ADMIN_PHONE:'22890000000',ADMIN_PASSWORD:'x-admin-pass-123'},stdio:'inherit'});
 try{
  await new Promise(r=>setTimeout(r,1500));
  const reg=await req(port,'POST','/api/register',{phone:'22891112233',password:'secret12'});assert(reg.j.data,'register');
  const H={Authorization:'Bearer '+reg.j.data.token};
  let r=await req(port,'POST','/api/saspay/deposit',{amount:2000,network:'Flooz',phone:'90112233'},H);
  assert(r.j.error&&/Activez/.test(r.j.error.message),'refus si compte non activé');
  const act=await req(port,'POST','/api/rpc/update_profile',{n:'Doe',pn:'Jane',em:'jane@example.com',mt:'Flooz',pay:'90112233'},H);assert(!act.j.error,'activation '+JSON.stringify(act.j));
  r=await req(port,'POST','/api/saspay/deposit',{amount:500,network:'Flooz',phone:'90112233'},H);assert(r.j.error,'montant min');
  r=await req(port,'POST','/api/saspay/deposit',{amount:2000,network:'Flooz',phone:'123'},H);assert(r.j.error,'numéro invalide');
  r=await req(port,'POST','/api/saspay/deposit',{amount:2000,network:'Flooz',phone:'90 11 22 33'},H);assert(r.j.data&&r.j.data.order_id,'création '+JSON.stringify(r.j));
  assert.strictEqual(lastBody.customer.first_name,'Jane');assert.strictEqual(lastBody.customer.last_name,'Doe');assert.strictEqual(lastBody.customer.email,'jane@example.com');
  assert.strictEqual(lastBody.customer.phone,'+22890112233');assert.strictEqual(lastBody.amount,'2000.00');assert.strictEqual(lastBody.country,'TG');assert.strictEqual(lastBody.network,'moov_tg');assert(lastKey,'idempotency');
  const oid=r.j.data.order_id;
  r=await req(port,'POST','/api/saspay/deposit',{amount:2000,network:'Flooz',phone:'90112233'},H);assert(r.j.error&&r.j.error.code!==0,'un seul paiement en cours');
  let st=await req(port,'GET','/api/saspay/status?order='+oid,null,H);assert.strictEqual(st.j.data.status,'pending');
  r=await hook(port,{event:'transaction.success',data:{id:'pay-1'}},{secret:'bad'});assert.strictEqual(r.s,403,'signature invalide');
  r=await hook(port,{event:'transaction.success',data:{id:'pay-1'}},{ts:Math.floor(Date.now()/1000)-1000});assert.strictEqual(r.s,403,'timestamp périmé');
  r=await hook(port,{event:'transaction.success',data:{id:'pay-1'}});assert.strictEqual(r.s,200);
  st=await req(port,'GET','/api/saspay/status?order='+oid,null,H);assert.strictEqual(st.j.data.status,'pending','pas de crédit si SasPay dit PENDING');
  payStatus='SUCCESS';
  r=await hook(port,{event:'transaction.success',data:{id:'pay-1'}});assert.strictEqual(r.s,200);
  await hook(port,{event:'transaction.success',data:{id:'pay-1'}});await req(port,'GET','/api/saspay/status?order='+oid,null,H);
  const me=await req(port,'GET','/api/t/profiles?q='+encodeURIComponent('{"one":true}'),null,H);
  assert.strictEqual(me.j.data.wallet_sub,2000,'crédit unique de 2000, obtenu '+me.j.data.wallet_sub);
  st=await req(port,'GET','/api/saspay/status?order='+oid,null,H);assert.strictEqual(st.j.data.status,'completed');
  console.log('OK : dépôt SasPay vérifié (préremplissage, signature, crédit unique)');
 }finally{srv.kill();mock.close();fs.rmSync(tmp,{recursive:true,force:true})}
})().catch(e=>{console.error('ÉCHEC',e);process.exit(1)});
