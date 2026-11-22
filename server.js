'use strict';
/* Fruty : serveur Node + PostgreSQL (Neon). Node >= 22.13. Lancer : npm start (variable DATABASE_URL requise) */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{createDb}=require('./backend/database/pg');
const PORT=+process.env.PORT||3000,PUBLIC_LINKS=Object.freeze({channel_url:(()=>{try{const u=new URL(process.env.FRUTY_CHANNEL_URL||'');return /^https?:$/.test(u.protocol)?u.toString():''}catch{return ''}})(),assistant_url:(()=>{try{const u=new URL(process.env.FRUTY_ASSISTANT_URL||'');return /^https?:$/.test(u.protocol)?u.toString():''}catch{return ''}})()}),DEPOSIT_METHODS=Object.freeze(Object.fromEntries([1,2,3,4,5].map(n=>[n,(process.env['DEPOSIT_METHOD_'+n]||(n===1?'saspay':'')).toLowerCase()]))),SASPAY_API_KEY=process.env.SASPAY_API_KEY||'',SASPAY_WEBHOOK_SECRET=process.env.SASPAY_WEBHOOK_SECRET||'',SASPAY_BASE=(process.env.SASPAY_BASE_URL||((process.env.SASPAY_API_KEY||'').startsWith('sk_test_')?'https://sandbox-api.saspay.me/api/v1':'https://api.saspay.me/api/v1')).replace(/\/$/,''),SASPAY_NETWORKS=Object.freeze({'T-Money':process.env.SASPAY_NETWORK_TMONEY||'tmoney_tg','Flooz':process.env.SASPAY_NETWORK_FLOOZ||'moov_tg'}),CHARIOW_API_KEY=process.env.CHARIOW_API_KEY||'',DEPOSIT_MIN=1000,DEPOSIT_MAX=100000,CHARIOW_PRODUCT_IDS=Object.freeze(Object.fromEntries([1,2,3,4,5].map(n=>[n,process.env['CHARIOW_PRODUCT_ID_M'+n]||process.env.CHARIOW_PRODUCT_ID||'prd_qc1stvd5']))),CHARIOW_PULSE_SECRET=process.env.CHARIOW_PULSE_SECRET||'',APP_BASE_URL=(process.env.APP_BASE_URL||'').replace(/\/$/,''),DATA=process.env.DATA_DIR||path.join(__dirname,'data'),PUB=path.join(__dirname,'public'),UP=path.join(DATA,'uploads'),PDF=path.join(DATA,'private-pdfs');
const db=createDb(process.env.DATABASE_URL),{all,one,run,tx}=db;
let SECRET=process.env.SECRET||''; // sinon généré et conservé dans la base (table app_secrets) : les sessions survivent aux redéploiements
class E extends Error{constructor(m,c){super(m);this.c=c||400}}
const uid=()=>crypto.randomUUID();

/* ---- sécurité : JWT, mots de passe (scrypt), TOTP, limitation de tentatives ---- */
const b64=b=>Buffer.from(b).toString('base64url');
const hm=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
const sign=(p,ttl)=>{const h=b64('{"alg":"HS256","typ":"JWT"}'),d=b64(JSON.stringify({...p,exp:Math.floor(Date.now()/1000)+ttl}));return h+'.'+d+'.'+hm(h+'.'+d)};
const verify=t=>{try{const [h,d,s]=t.split('.');if(!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(hm(h+'.'+d))))return null;const p=JSON.parse(Buffer.from(d,'base64url'));return p.exp>Date.now()/1000?p:null}catch{return null}};
const hashPw=p=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(p,s,64).toString('hex')};
const checkPw=(p,h)=>{try{const [s,x]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(p,s,64),Buffer.from(x,'hex'))}catch{return false}};
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32=buf=>{let bits='',o='';for(const x of buf)bits+=x.toString(2).padStart(8,'0');for(let i=0;i<bits.length;i+=5)o+=B32[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];return o};
const unb32=s=>{let bits='';for(const c of s)bits+=B32.indexOf(c).toString(2).padStart(5,'0');const o=[];for(let i=0;i+8<=bits.length;i+=8)o.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(o)};
const totp=(sec,t)=>{const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(t/30000)));const h=crypto.createHmac('sha1',unb32(sec)).update(c).digest(),o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0')};
const okTotp=(sec,code)=>[-1,0,1].some(w=>totp(sec,Date.now()+w*30000)===String(code||'').trim());
const hits=new Map();
const limit=(k,max=8,win=900000)=>{const n=Date.now(),h=hits.get(k)||{n:0,t:n};if(n-h.t>win){h.n=0;h.t=n}if(++h.n>max)throw new E('Trop de tentatives. Réessayez dans quelques minutes.',429);hits.set(k,h)};

/* ---- règles métier (équivalent des fonctions sécurisées) : tout l'argent est décidé ici ---- */
const VIP=[0,1000,5000,20000],QUESTION_REWARD=25,DAILY_QUESTIONS=4,WELCOME_GIFT=200,PURCHASE_BONUS=300,BONUS_WINDOW_DAYS=5,QUESTION_BANK=require('./backend/database/question-bank.js');
const user=id=>one('select * from profiles where id=?',id);
const act=u=>{if(!u.active)throw new E('Activez votre compte dans Paramètres');return u};
const led=(u,k,a)=>run('insert into ledger(user_id,kind,amount) values(?,?,?)',u,k,a);
/* Banque de questions : 4 questions aléatoires par jour, les moins récemment utilisées d'abord */
async function seedQuestionBank(){for(const [i,q] of QUESTION_BANK.entries())await run('insert into question_bank(id,prompt,options_json,correct_option,explanation) values(?,?,?,?,?) on conflict do nothing',i+1,q[0],JSON.stringify(q[1]),q[2],q[3]||'')}
async function ensureDailyQuestions(day){/* sans transaction propre : l'appelant gère la transaction (Node est mono-thread) */
 const now=(await one('select count(*) c from daily_questions where question_date=? and active=1',day)).c;if(now>=DAILY_QUESTIONS)return;
 const picks=await all('select * from question_bank where prompt not in (select prompt from daily_questions where question_date=?) order by coalesce(last_used_date,\'\') asc,random() limit ?',day,DAILY_QUESTIONS-now);
 let order=(await one('select coalesce(max(sort_order),0) n from daily_questions where question_date=?',day)).n;
 for(const q of picks){await run('insert into daily_questions(id,question_date,prompt,options_json,correct_option,explanation,sort_order) values(?,?,?,?,?,?,?)',uid(),day,q.prompt,q.options_json,q.correct_option,q.explanation,++order);await run('update question_bank set last_used_date=? where id=?',day,q.id)}}
const today=()=>new Date().toISOString().slice(0,10);
async function bonusState(p){
 const claimed=k=>one('select amount,claimed_at from user_bonuses where user_id=? and kind=?',p.id,k),w=await claimed('welcome'),b=await claimed('purchase');
 const deadline=new Date(new Date(p.created_at).getTime()+BONUS_WINDOW_DAYS*864e5).toISOString();
 const bought=await one('select 1 x from product_accesses where user_id=? and purchased_at<=? limit 1',p.id,deadline);
 const purchase=b?'claimed':bought?'available':(new Date()>new Date(deadline)?'expired':'locked');
 return {welcome_amount:WELCOME_GIFT,welcome_claimed:w?1:0,purchase_amount:PURCHASE_BONUS,purchase_state:purchase,purchase_deadline:deadline,window_days:BONUS_WINDOW_DAYS}}
const audit=(admin,action,type,target,details,ip)=>run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,?,?,?,?,?,?)',uid(),admin.id,action,type,String(target||''),JSON.stringify(details||{}),ip||null);
// Garde-fou : le total des crédits promotionnels d'un PDF doit rester strictement inférieur à son prix.
const MAX_REWARD_RATIO=0.5;
// Les achats historiques conservent leur ancien fonctionnement. Les nouveaux achats
// accumulent une ligne par jour échu, puis versent le total dans wallet_gain à l'échéance.
// UNIQUE(access_id, reward_number) + rewards_paid_at garantissent l'idempotence.
const settlePurchaseRewards=userId=>tx(async()=>{
 const now=Date.now(),rows=await all('select * from product_accesses where user_id=? and access_days>0 and daily_reward>0',userId);
 for(const a of rows){
  const start=Date.parse(a.purchased_at);if(!Number.isFinite(start))continue;
  const elapsed=Math.max(0,Math.floor((now-start)/86400000));
  const due=Math.min(a.access_days,elapsed);
  if(a.reward_mode==='maturity'){
   if(a.rewards_paid_at)continue;
   for(let n=1;n<=due;n++){
    if(await one('select 1 from product_reward_credits where access_id=? and reward_number=?',a.id,n))continue;
    await run('insert into product_reward_credits(id,access_id,user_id,reward_number,amount) values(?,?,?,?,?)',uid(),a.id,userId,n,a.daily_reward);
   }
   if(due>=a.access_days){
    const total=(await one('select coalesce(sum(amount),0) amount from product_reward_credits where access_id=?',a.id)).amount;
    if(total>0){await run('update profiles set wallet_gain=wallet_gain+? where id=?',total,userId);await led(userId,'recompense_pdf',total)}
    await run('update product_accesses set rewards_paid_at=? where id=? and rewards_paid_at is null',new Date(now).toISOString(),a.id);
   }
   continue;
  }
  // Compatibilité : crédits déjà configurés avant la migration 008.
  for(let n=1;n<=a.access_days;n++){
   if(start+(n-1)*86400000>now)break;
   if(await one('select 1 from product_reward_credits where access_id=? and reward_number=?',a.id,n))continue;
   await run('insert into product_reward_credits(id,access_id,user_id,reward_number,amount) values(?,?,?,?,?)',uid(),a.id,userId,n,a.daily_reward);
   await run('update profiles set wallet_sub=wallet_sub+? where id=?',a.daily_reward,userId);await led(userId,'recompense_pdf',a.daily_reward);
  }
 }
});
const settleAllPurchaseRewards=async()=>{for(const row of await all('select distinct user_id from product_accesses where access_days>0 and daily_reward>0'))await settlePurchaseRewards(row.user_id)};
const RPC={
 update_profile:async(u,{n,pn,em,mt,pay})=>{if((await user(u.id)).active)throw new E('Votre compte est déjà activé. Pour modifier vos informations, contactez le support : sikaplus.con0125@gmail.com.');if(String(n||'').trim().length<2||String(pn||'').trim().length<2||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em||'')||String(pay||'').trim().length<4)throw new E('Informations invalides');
  await run('update profiles set nom=?,prenom=?,email=?,method=?,paynum=?,active=1 where id=?',String(n).trim().slice(0,60),String(pn).trim().slice(0,60),String(em).slice(0,120),String(mt||'').slice(0,30),String(pay).trim().slice(0,40),u.id);return true},
 submit_deposit:(u,{a,r})=>tx(async()=>{const p=act(await user(u.id));a=Math.floor(+a);r=String(r||'').trim().toLowerCase();
  if(!Number.isInteger(a)||a<DEPOSIT_MIN||a>DEPOSIT_MAX)throw new E('Le montant doit être compris entre 1 000 et 100 000 FCFA.');if(r.length<4||r.length>60||(r.startsWith('chariow:')||r.startsWith('saspay:')))throw new E('Référence invalide.');
  if(await one('select 1 from deposits where ref=?',r))throw new E('Cette référence a déjà été utilisée');await run('insert into deposits(id,user_id,amount,ref) values(?,?,?,?)',uid(),p.id,a,r);return true}),
 request_withdrawal:(u,{a,m,d})=>tx(async()=>{const p=act(await user(u.id));a=Math.floor(+a);
  if(!(a>=500))throw new E('Retrait minimum : 500 FCFA');if(a>p.wallet_gain)throw new E('Gains insuffisants');if(String(d||'').replace(/\D/g,'').length<8)throw new E('Numéro de réception invalide');
  await run('update profiles set wallet_gain=wallet_gain-? where id=?',a,p.id);await run('insert into withdrawals(id,user_id,amount,method,dest) values(?,?,?,?,?)',uid(),p.id,a,String(m||'').slice(0,30),String(d).slice(0,30));await led(p.id,'retrait',a);return true}),
 buy_product:(u,{pid})=>tx(async()=>{const p=act(await user(u.id)),x=await one('select price,access_days,daily_reward from products where id=? and hidden=0',pid);
  if(!x||!x.price)throw new E('Produit indisponible');
  const active=await one("select 1 from product_accesses where user_id=? and product_id=? and (expires_at is null or expires_at>fruty_now())",p.id,pid);
  if(active)throw new E('Vous avez déjà un accès actif à ce PDF.');if(p.wallet_sub<x.price)throw new E('Solde insuffisant');
  const days=Math.max(0,Math.floor(x.access_days||0)),reward=Math.max(0,Math.floor(x.daily_reward||0));
  if(days===0&&reward>0)throw new E('Une récompense journalière exige une durée d’accès définie.');
  const purchasedAt=new Date().toISOString(),expiresAt=days?new Date(Date.now()+days*86400000).toISOString():null;
  await run('update profiles set wallet_sub=wallet_sub-? where id=?',x.price,p.id);
  await run("insert into product_accesses(id,user_id,product_id,price,access_days,daily_reward,purchased_at,expires_at,reward_mode) values(?,?,?,?,?,?,?,?, 'maturity')",uid(),p.id,pid,x.price,days,reward,purchasedAt,expiresAt);
  await run('insert into purchases(user_id,product_id,price,created_at) values(?,?,?,?) on conflict do nothing',p.id,pid,x.price,purchasedAt);await led(p.id,'achat',x.price);return {expires_at:expiresAt,access_days:days,daily_reward:reward}}),
 set_vip:(u,{n})=>tx(async()=>{const p=act(await user(u.id));n=Math.floor(+n);if(!(n>p.vip&&n<=3))throw new E('Niveau invalide');if(p.wallet_sub<VIP[n])throw new E('Solde insuffisant');
  await run('update profiles set wallet_sub=wallet_sub-?,vip=? where id=?',VIP[n],n,p.id);await led(p.id,'vip',VIP[n]);return true}),
 claim_welcome:u=>tx(async()=>{const p=act(await user(u.id));if(await one("select 1 from user_bonuses where user_id=? and kind='welcome'",p.id))throw new E('Le cadeau de bienvenue a déjà été récupéré.');await run("insert into user_bonuses(user_id,kind,amount) values(?,'welcome',?)",p.id,WELCOME_GIFT);await run('update profiles set wallet_sub=wallet_sub+? where id=?',WELCOME_GIFT,p.id);await led(p.id,'bienvenue',WELCOME_GIFT);return {amount:WELCOME_GIFT}}),
 claim_purchase_bonus:u=>tx(async()=>{const p=act(await user(u.id)),st=await bonusState(p);if(st.purchase_state==='claimed')throw new E('Ce bonus a déjà été récupéré.');if(st.purchase_state==='expired')throw new E('Ce bonus a expiré : il fallait acheter un produit dans les '+BONUS_WINDOW_DAYS+' jours suivant la création du compte.');if(st.purchase_state!=='available')throw new E('Achetez un produit dans les '+BONUS_WINDOW_DAYS+' jours suivant la création de votre compte pour débloquer ce bonus.');await run("insert into user_bonuses(user_id,kind,amount) values(?,'purchase',?)",p.id,PURCHASE_BONUS);await run('update profiles set wallet_sub=wallet_sub+? where id=?',PURCHASE_BONUS,p.id);await led(p.id,'bonus_achat',PURCHASE_BONUS);return {amount:PURCHASE_BONUS}}),
 answer_daily_question:(u,{qid,choice})=>tx(async()=>{const p=act(await user(u.id)),day=today();await ensureDailyQuestions(day);if((await one('select count(*) c from daily_questions where question_date=? and active=1',day)).c!==DAILY_QUESTIONS)throw new E('Les questions du jour ne sont pas encore disponibles.');const q=await one('select * from daily_questions where id=? and question_date=? and active=1',String(qid||''),day);
  if(!q)throw new E('Cette question n’est plus disponible.');
  if(await one('select 1 from daily_question_answers where user_id=? and question_id=?',p.id,q.id))throw new E('Vous avez déjà répondu à cette question.');
  const options=JSON.parse(q.options_json);choice=Number(choice);if(!Number.isInteger(choice)||choice<0||choice>=options.length)throw new E('Réponse invalide.');
  const correct=choice===q.correct_option,reward=correct?QUESTION_REWARD:0;
  await run('insert into daily_question_answers(id,user_id,question_id,question_date,selected_option,is_correct,reward_amount) values(?,?,?,?,?,?,?)',uid(),p.id,q.id,day,choice,correct?1:0,reward);
  if(reward){await run('update profiles set wallet_sub=wallet_sub+? where id=?',reward,p.id);await led(p.id,'question',reward)}
  return {correct,reward,explanation:q.explanation||''}}),
 my_team:u=>all("select left(phone,3)||'•••'||right(phone,2) phone,created_at from profiles where inviter=? order by created_at desc",u.id)
};
/* lecture : chaque client ne voit que ses propres lignes ; le contenu payant seulement s'il est acheté */
const T={
 profiles:u=>all('select id,phone,role,code,wallet_sub,wallet_gain,vip,active,nom,prenom,email,method,paynum,created_at from profiles where id=?',u.id),
 products:()=>all('select id,sym,name,color,price,teaser,image_url,pos,access_days,daily_reward from products where hidden=0 order by pos'),
 product_content:u=>all("select p.id product_id,p.facts,p.body,p.pdf_url from products p join product_accesses a on a.product_id=p.id where a.user_id=? and (a.expires_at is null or a.expires_at>fruty_now()) order by a.purchased_at desc",u.id),
 deposit_options:()=>[1,2,3,4,5].map(n=>({method:n,label:'Méthode '+n})),
 deposits:u=>all('select id,amount,ref,status,created_at from deposits where user_id=?',u.id),
 withdrawals:u=>all('select id,amount,method,dest,status,created_at from withdrawals where user_id=?',u.id),
 purchases:async u=>(await all("select a.id,a.product_id,p.name,p.sym,p.image_url,a.price,a.purchased_at created_at,a.expires_at,a.access_days,a.daily_reward,a.reward_mode,a.rewards_paid_at,(select count(*) from product_reward_credits rc where rc.access_id=a.id) rewards_paid_count,(select coalesce(sum(amount),0) from product_reward_credits rc where rc.access_id=a.id) rewards_paid,case when a.expires_at is null or a.expires_at>fruty_now() then 1 else 0 end active from product_accesses a join products p on p.id=a.product_id where a.user_id=? order by a.purchased_at desc",u.id)).map(a=>{const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(a.created_at))/86400000));const days=Math.min(a.access_days,elapsed);const total=a.daily_reward*a.access_days;const maturity=a.reward_mode==='maturity';return {...a,rewards_total:total,reward_days_elapsed:maturity?Math.min(a.rewards_paid_count,a.access_days):days,reward_days_remaining:maturity?Math.max(0,a.access_days-a.rewards_paid_count):Math.max(0,a.access_days-days),reward_progress:maturity?(a.access_days?Math.min(100,Math.round(a.rewards_paid_count/a.access_days*100)):0):(a.access_days?Math.min(100,Math.round(days/a.access_days*100)):0),rewards_status:maturity?(a.rewards_paid_at?'paid':'pending'):(a.rewards_paid>=total?'legacy-paid':'legacy')}}),
 daily_questions:async u=>{await tx(async()=>ensureDailyQuestions(today()));return await all("select q.id,q.question_date,q.prompt,q.options_json,q.sort_order,case when a.id is null then 0 else 1 end answered,case when a.id is null then null else a.is_correct end is_correct,case when a.id is null then 0 else a.reward_amount end reward_amount,case when a.id is null then '' else q.explanation end explanation from daily_questions q left join daily_question_answers a on a.question_id=q.id and a.user_id=? where q.question_date=? and q.active=1 order by q.sort_order",u.id,today())},
 bonuses:async u=>[await bonusState(await user(u.id))],
 ledger:u=>all('select kind,amount,created_at from ledger where user_id=?',u.id),
 task_log:u=>all('select day,task_id from task_log where user_id=?',u.id),
 announcements:()=>all('select id,title,body,created_at from announcements')
};
const hex=c=>/^#[0-9a-f]{6}$/i.test(c||'')?c:'#7C3AED',pint=v=>{v=Math.floor(+v);return v>0?v:null};
const L={
 deposits:()=>all('select d.*,p.phone from deposits d join profiles p on p.id=d.user_id order by d.created_at desc limit 200'),
 withdrawals:()=>all('select w.*,p.phone from withdrawals w join profiles p on p.id=w.user_id order by w.created_at desc limit 200'),
 users:()=>all('select id,phone,role,wallet_sub,wallet_gain,vip,active,created_at from profiles order by created_at desc limit 500'),
 products:()=>all('select * from products order by pos'),options:()=>all('select * from deposit_options order by amount'),
 purchases:()=>all("select a.id,a.user_id,pf.phone,pr.name product_name,a.price,a.purchased_at,a.expires_at,a.access_days,a.daily_reward,(select count(*) from product_reward_credits rc where rc.access_id=a.id) rewards_paid_count,(select coalesce(sum(amount),0) from product_reward_credits rc where rc.access_id=a.id) rewards_paid,a.reward_mode,a.rewards_paid_at from product_accesses a join profiles pf on pf.id=a.user_id join products pr on pr.id=a.product_id order by a.purchased_at desc limit 300"),
 questions:date=>all('select q.id,q.question_date,q.prompt,q.options_json,q.correct_option,q.explanation,q.sort_order,q.active,(select count(*) from daily_question_answers a where a.question_id=q.id) answer_count from daily_questions q where q.question_date=? order by q.sort_order',date),
 announcements:()=>all('select * from announcements order by created_at desc')
};

/* ---- Paiement Chariow : le serveur préremplit le checkout et le Pulse confirme le crédit ---- */
async function createChariowDeposit(u, req, amount, method) {
 if(!Number.isInteger(amount)||amount<DEPOSIT_MIN||amount>DEPOSIT_MAX)throw new E('Le montant du dépôt doit être compris entre 1 000 et 100 000 FCFA.');
 if(!Number.isInteger(method)||method<1||method>5)throw new E('Choisissez une méthode de dépôt (Méthode 1 à Méthode 5).');
 const p=act(await user(u.id)),productId=CHARIOW_PRODUCT_IDS[method];
 if(!CHARIOW_API_KEY||!productId)throw new E('La méthode '+method+' n’est pas encore configurée par l’administrateur.',503);
 if(!p.nom||!p.prenom||!p.email||!p.method||!p.paynum)throw new E('Complétez d’abord vos informations dans Paramètres pour continuer.');
 const mobile=['T-Money','Flooz'].includes(p.method),buyerPhone=mobile?p.paynum:p.phone;
 let number=String(buyerPhone||'').replace(/\D/g,'');
 if(number.startsWith('228')&&number.length===11)number=number.slice(3);
 if(number.length<8||number.length>15)throw new E('Le numéro de téléphone du payeur est invalide.');
 const id=uid(),depositRef='chariow:'+id;
 await tx(async()=>{
  await run('insert into chariow_orders(id,user_id,amount,product_id,deposit_ref) values(?,?,?,?,?)',id,p.id,amount,productId,depositRef);
  await run('insert into deposits(id,user_id,amount,ref,status) values(?,?,?,?,?)',uid(),p.id,amount,depositRef,'attente');
 });
 const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
 const payload={product_id:productId,amount,email:p.email,first_name:p.prenom,last_name:p.nom,
  phone:{number,country_code:'TG'},payment_currency:'XOF',
  custom_metadata:{sikaplus_order_id:id,sikaplus_user_id:p.id,sikaplus_amount:String(amount),sikaplus_deposit_method:String(method),sikaplus_payment_method:p.method,sikaplus_payment_number:number}};
 if(forwarded && /^[0-9a-f:.]+$/i.test(forwarded))payload.customer_ip=forwarded;
 if(APP_BASE_URL)payload.redirect_url=APP_BASE_URL+'/?payment=chariow#depot';
 try{
  const response=await fetch('https://api.chariow.com/v1/checkout',{method:'POST',headers:{Authorization:'Bearer '+CHARIOW_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.message||JSON.stringify(result.errors||'Erreur API Chariow'));
  const data=result.data||result,checkoutUrl=String(data.payment&&data.payment.checkout_url||'');
  let parsedCheckoutUrl=null;try{parsedCheckoutUrl=new URL(checkoutUrl)}catch{}
  if(data.step!=='payment'||!data.payment||!parsedCheckoutUrl||parsedCheckoutUrl.protocol!=='https:'||parsedCheckoutUrl.username||parsedCheckoutUrl.password)throw new Error('Chariow n’a pas retourné une URL de paiement HTTPS valide. Vérifiez le produit et son prix.');
  await run('update chariow_orders set sale_id=?,transaction_id=? where id=?',data.purchase&&data.purchase.id||null,data.payment.transaction_id||null,id);
  return {checkout_url:parsedCheckoutUrl.toString(),order_id:id};
 }catch(err){
  await tx(async()=>{await run("update chariow_orders set status='failed' where id=?",id);await run("update deposits set status='refuse' where ref=?",depositRef)});
  console.error('Chariow checkout:',err.message);
  throw new E('Impossible de créer le paiement avec la méthode '+method+'. Réessayez ou choisissez une autre méthode.',502);
 }
}
async function chariowWebhook(req,res){
 let raw='';req.setEncoding('utf8');for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024){res.writeHead(413);return res.end('Payload too large')}}
 const signature=String(req.headers['x-chariow-signature']||''),delivery=String(req.headers['x-pulse-delivery-id']||''),eventHeader=String(req.headers['x-pulse-event']||'');
 if(!CHARIOW_PULSE_SECRET){res.writeHead(503);return res.end('Webhook secret not configured')}
 const expected='sha256='+crypto.createHmac('sha256',CHARIOW_PULSE_SECRET).update(raw,'utf8').digest('hex');
 const a=Buffer.from(signature),b=Buffer.from(expected);
 if(!signature||a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.writeHead(401);return res.end('Invalid signature')}
 if(!delivery||delivery.length>200){res.writeHead(400);return res.end('Missing delivery id')}
 let payload;try{payload=JSON.parse(raw)}catch{res.writeHead(400);return res.end('Invalid JSON')}
 const event=String(payload.event||eventHeader||'');
 try{
  const outcome=await tx(async()=>{
   if(await one('select 1 from chariow_pulse_deliveries where delivery_id=?',delivery))return 'duplicate';
   const sale=payload.sale||{},product=payload.product||{},meta=sale.custom_metadata||{};
   const saleId=String(sale.id||''),orderId=String(meta.sikaplus_order_id||'');
   if(event!=='successful.sale'){
    await run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,orderId||null,'ignored_event');
    return 'ignored_event';
   }
   // L'identifiant de commande est la clé de rapprochement principale. Le sale_id
   // seul n'est jamais suffisant pour choisir le compte à créditer.
   const order=orderId?await one('select * from chariow_orders where id=?',orderId):null;
   if(!order){
    await run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,orderId||null,'order_not_found');
    console.warn('Chariow Pulse: commande introuvable', {delivery_id:delivery,order_id:orderId||null});
    return 'order_not_found';
   }
   const metaAmount=Number(meta.sikaplus_amount),metaUser=String(meta.sikaplus_user_id||'');
   const amount=sale.amount||{},saleAmount=Number(amount.value),currency=String(amount.currency||'').toUpperCase();
   const saleMatches=!order.sale_id||order.sale_id===saleId;
   const metadataMatches=metaUser===order.user_id&&Number.isSafeInteger(metaAmount)&&metaAmount===order.amount;
   const paymentMatches=sale.status==='completed'&&Number.isSafeInteger(saleAmount)&&saleAmount===order.amount&&currency==='XOF';
   const productMatches=String(product.id||'')===order.product_id;
   if(order.status!=='pending'||!saleId||!saleMatches||!metadataMatches||!paymentMatches||!productMatches){
    await run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,order.id,'rejected_mismatch');
    console.warn('Chariow Pulse: notification non concordante', {delivery_id:delivery,order_id:order.id,order_status:order.status,product_matches:productMatches,metadata_matches:metadataMatches,payment_matches:paymentMatches,sale_matches:saleMatches});
    return 'rejected_mismatch';
   }
   const dep=await one("select id,user_id,amount,status from deposits where ref=?",order.deposit_ref);
   if(!dep||dep.user_id!==order.user_id||dep.amount!==order.amount||dep.status!=='attente'){
    await run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId,order.id,'deposit_not_pending');
    console.warn('Chariow Pulse: dépôt associé absent ou incohérent', {delivery_id:delivery,order_id:order.id});
    return 'deposit_not_pending';
   }
   // Le verrou de transaction PostgreSQL (tx) et les statuts pending/attente
   // rendent le crédit atomique et idempotent, y compris en cas de requêtes concurrentes.
   if((await run("update deposits set status='valide' where id=? and status='attente'",dep.id)).changes!==1)throw new Error('Le dépôt a déjà été traité');
   await run('update profiles set wallet_sub=wallet_sub+? where id=?',order.amount,order.user_id);
   await led(order.user_id,'depot',order.amount);
   if((await run("update chariow_orders set sale_id=coalesce(sale_id,?),status='completed',completed_at=fruty_now() where id=? and status='pending'",saleId,order.id)).changes!==1)throw new Error('La commande Chariow a déjà été traitée');
   await run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId,order.id,'credited');
   await run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,NULL,?,?,?,?,?)',uid(),'chariow_auto_credit','chariow_order',order.id,JSON.stringify({user_id:order.user_id,amount:order.amount,currency:'XOF',sale_id:saleId,delivery_id:delivery}),null);
   return 'credited';
  });
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(outcome==='credited'?'OK':outcome==='duplicate'?'OK':'IGNORED');
 }catch(err){console.error('Chariow Pulse processing error:',err);res.writeHead(500);res.end('Processing error')}
}

/* ---- Paiement SasPay (Softpay) : numéro + réseau + montant ; nom/prénom/email viennent du profil activé ---- */
const spHeaders=extra=>({Authorization:'Bearer '+SASPAY_API_KEY,'Content-Type':'application/json',...extra});
const spData=j=>(j&&j.data&&typeof j.data==='object')?j.data:(j||{});
function normTogoPhone(v){let n=String(v||'').replace(/\D/g,'');if(n.startsWith('00228'))n=n.slice(5);if(n.startsWith('228')&&n.length===11)n=n.slice(3);return /^\d{8}$/.test(n)?n:null}
async function creditSaspayOrder(orderId,source){
 return await tx(async()=>{
  const order=await one('select * from saspay_orders where id=?',orderId);
  if(!order||order.status!=='pending')return 'already';
  const dep=await one("select id from deposits where ref=? and status='attente'",order.deposit_ref);
  if(!dep)return 'deposit_not_pending';
  await run("update deposits set status='valide' where id=? and status='attente'",dep.id);
  await run('update profiles set wallet_sub=wallet_sub+? where id=?',order.amount,order.user_id);
  await led(order.user_id,'depot',order.amount);
  await run("update saspay_orders set status='completed',completed_at=fruty_now() where id=? and status='pending'",order.id);
  await run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,NULL,?,?,?,?,?)',uid(),'saspay_auto_credit','saspay_order',order.id,JSON.stringify({user_id:order.user_id,amount:order.amount,currency:'XOF',payment_id:order.payment_id,source}),null);
  return 'credited';
 });
}
async function failSaspayOrder(orderId){
 return await tx(async()=>{const o=await one('select * from saspay_orders where id=?',orderId);if(!o||o.status!=='pending')return false;
  await run("update saspay_orders set status='failed' where id=? and status='pending'",o.id);await run("update deposits set status='refuse' where ref=? and status='attente'",o.deposit_ref);return true});
}
/* Vérifie l'état réel auprès de SasPay puis crédite ou refuse. Appelé par le webhook ET par le suivi du client. */
async function reconcileSaspayOrder(order,source){
 if(!order||order.status!=='pending'||!order.payment_id)return order&&order.status;
 if(order.payment_id.startsWith('cs:')){
  let sd;
  try{const r=await fetch(SASPAY_BASE+'/checkout-sessions/'+encodeURIComponent(order.payment_id.slice(3))+'/status/',{headers:spHeaders(),signal:AbortSignal.timeout(15000)});if(!r.ok)return 'pending';sd=spData(await r.json().catch(()=>({})))}catch{return 'pending'}
  const ss=String(sd.status||'').toUpperCase(),ts=String(sd.transaction_status||'').toUpperCase();
  if(ss==='PAID'&&ts==='SUCCESS'&&sd.transaction_id)order={...order,payment_id:String(sd.transaction_id)};
  else{if(/EXPIR|CANCEL|FAIL/.test(ss))await failSaspayOrder(order.id);return (await one('select status from saspay_orders where id=?',order.id)).status}
 }
 let d;
 try{const r=await fetch(SASPAY_BASE+'/payments/'+encodeURIComponent(order.payment_id)+'/verify/',{headers:spHeaders(),signal:AbortSignal.timeout(15000)});if(!r.ok)return 'pending';d=spData(await r.json().catch(()=>({})))}catch{return 'pending'}
 const st=String(d.status||'').toUpperCase();
 if(st==='SUCCESS'){
  const req=Math.round(Number(d.requested_amount||0)),net=Math.round(Number(d.net_amount||0)),cur=String(d.currency||'XOF');
  if(cur!=='XOF'||(req!==order.amount&&net!==order.amount)){console.warn('SasPay: montant non concordant',{order_id:order.id,expected:order.amount,requested:req,net});return 'pending'}
  await creditSaspayOrder(order.id,source);
 }else if(/FAIL|CANCEL|EXPIR|REJECT|DECLIN|TIMEOUT/.test(st))await failSaspayOrder(order.id);
 return (await one('select status from saspay_orders where id=?',order.id)).status;
}
let spNetCache={t:0,list:[]};
async function saspayTogoNetworks(){
 if(Date.now()-spNetCache.t<600000&&spNetCache.list.length)return spNetCache.list;
 const pick=b=>{if(Array.isArray(b))return b;if(!b||typeof b!=='object')return [];for(const k of ['results','data','networks','items']){const v=b[k];if(Array.isArray(v))return v;if(v&&typeof v==='object'){const w=pick(v);if(w.length)return w}}return []};
 try{let all=[],url=SASPAY_BASE+'/networks/?page_size=100',pg=0;
  while(url&&pg++<10){const r=await fetch(url,{headers:spHeaders(),signal:AbortSignal.timeout(15000)});if(!r.ok)break;const j=await r.json().catch(()=>({}));all=all.concat(pick(j));url=typeof j.next==='string'&&j.next.startsWith('https://')?j.next:null}
  const tg=all.filter(x=>/_tg$/i.test(String(x.code||'')));
  if(tg.length){spNetCache={t:Date.now(),list:tg};console.log('SasPay réseaux Togo disponibles :',tg.map(x=>x.code+(x.name?' ('+x.name+')':'')).join(', '))}
  else console.log('SasPay : aucun réseau Togo trouvé dans la liste ('+all.length+' réseaux reçus).');
  return tg}catch(e){console.log('SasPay : liste des réseaux inaccessible ('+e.message+')');return []}
}
async function saspayNetworkCandidates(label){
 const list=await saspayTogoNetworks(),flooz=label==='Flooz',re=flooz?/moov|flooz/i:/togocel|mixx|t-?money|yas/i;
 const m=list.filter(x=>re.test(String(x.code||'')+' '+String(x.name||''))).sort((x,y)=>(/togocel/i.test(y.code+' '+y.name)?1:0)-(/togocel/i.test(x.code+' '+x.name)?1:0)).map(x=>x.code);
 const extra=flooz?['moov_tg']:['togocel_money_tg','togocel_tg','mixx_tg','tmoney_tg'];
 return [...new Set([SASPAY_NETWORKS[label],...m,...extra].filter(Boolean))].sort((x,y)=>(m.includes(y)?1:0)-(m.includes(x)?1:0));
}
function reqBase(req){
 if(APP_BASE_URL)return APP_BASE_URL;
 const host=String(req.headers.host||''),proto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()||(req.socket.encrypted?'https':'http');
 return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)&&/^https?$/.test(proto)?proto+'://'+host:'';
}
async function createSaspayCheckout(p,amount,number,orderId,base){
 const payload={amount:amount.toFixed(2),currency:'XOF',description:'Dépôt Fruty',country:'TG',customer_email:p.email,customer_name:(p.prenom+' '+p.nom).trim(),customer_phone:'+228'+number,metadata:{order_id:orderId,user_id:p.id}};
 if(base)payload.return_url=base+'/?payment=saspay#depot';
 const r=await fetch(SASPAY_BASE+'/checkout-sessions/',{method:'POST',headers:spHeaders(),body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
 const j=await r.json().catch(()=>({})),d=spData(j);
 let url=null;try{const c=new URL(String(d.checkout_url||''));if(c.protocol==='https:'&&!c.username&&!c.password)url=c.toString()}catch{}
 if(!r.ok||!d.id||!url)throw new Error((j.error&&j.error.message)||j.message||j.detail||'Session de checkout refusée');
 return {id:String(d.id),url};
}
async function createSaspayDeposit(u,req,amount,network,phoneRaw){
 if(!Number.isInteger(amount)||amount<DEPOSIT_MIN||amount>DEPOSIT_MAX)throw new E('Le montant du dépôt doit être compris entre 1 000 et 100 000 FCFA.');
 if(network!=='auto'&&!SASPAY_NETWORKS[network])throw new E('Choisissez une méthode de dépôt.');
 const number=normTogoPhone(phoneRaw);if(!number)throw new E('Entrez un numéro togolais valide à 8 chiffres.');
 if(!SASPAY_API_KEY)throw new E('Le dépôt en ligne n’est pas encore configuré par l’administrateur.',503);
 const p=act(await user(u.id));
 if(!p.nom||!p.prenom||!p.email)throw new E('Complétez d’abord vos informations dans Paramètres pour continuer.');
 if(await one("select 1 from saspay_orders where user_id=? and status='pending' and created_at>fruty_ago(interval '3 minutes')",p.id))throw new E('Un paiement est déjà en cours. Validez-le sur votre téléphone ou patientez 3 minutes.',429);
 const id=uid(),depositRef='saspay:'+id,base=reqBase(req);
 await tx(async()=>{await run('insert into saspay_orders(id,user_id,amount,network,phone,deposit_ref) values(?,?,?,?,?,?)',id,p.id,amount,network,number,depositRef);
  await run('insert into deposits(id,user_id,amount,ref,status) values(?,?,?,?,?)',uid(),p.id,amount,depositRef,'attente')});
 const payload={amount:amount.toFixed(2),currency:'XOF',country:'TG',network:'',description:'Dépôt Fruty',
  customer:{email:p.email,first_name:p.prenom,last_name:p.nom,phone:'+228'+number},metadata:{order_id:id,user_id:p.id}};
 if(base)payload.return_url=base+'/?payment=saspay#depot';
 try{
  if(network==='auto'){
   const cs=await createSaspayCheckout(p,amount,number,id,base);
   await run('update saspay_orders set payment_id=? where id=?','cs:'+cs.id,id);
   return {order_id:id,checkout_url:cs.url,message:'Redirection vers la page de paiement…'};
  }
  let r,j,d,lastMsg='';
  for(const [i,code] of (await saspayNetworkCandidates(network)).entries()){
   payload.network=code;
   r=await fetch(SASPAY_BASE+'/payments/softpay/',{method:'POST',headers:spHeaders({'Idempotency-Key':id+'-'+i}),body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
   j=await r.json().catch(()=>({}));d=spData(j);
   lastMsg=(j.error&&j.error.message)||j.message||j.detail||'';
   if(!r.ok&&r.status===422&&/inconnu|inactif|invalid_method|unknown|inactive/i.test(JSON.stringify(j))){console.log('SasPay : réseau refusé ('+code+'), essai suivant…');continue}
   if(r.ok)console.log('SasPay : paiement lancé avec le réseau '+code);
   break;
  }
  if(!r.ok&&r.status===422&&/no_route|fournisseur|route/i.test(JSON.stringify(j))){
   console.log('SasPay : aucun fournisseur pour le paiement direct, bascule vers la page de paiement SasPay.');
   const cs=await createSaspayCheckout(p,amount,number,id,base);
   await run('update saspay_orders set payment_id=? where id=?','cs:'+cs.id,id);
   return {order_id:id,checkout_url:cs.url,message:'Redirection vers la page de paiement…'};
  }
  if(!r.ok||j.success===false||!d.id)throw new Error(lastMsg||JSON.stringify(j.error||j).slice(0,300)||'Erreur API SasPay');
  let checkout=null;if(d.checkout_url){try{const c=new URL(String(d.checkout_url));if(c.protocol==='https:'&&!c.username&&!c.password)checkout=c.toString()}catch{}}
  await run('update saspay_orders set payment_id=? where id=?',String(d.id),id);
  return {order_id:id,checkout_url:checkout,message:d.instructions||d.message||'Validez le paiement sur votre téléphone.'};
 }catch(err){await failSaspayOrder(id);console.error('SasPay softpay:',err.message);throw new E('Impossible de lancer le paiement. Vérifiez le numéro et le réseau, puis réessayez.',502)}
}
async function saspayWebhook(req,res){
 let raw='';req.setEncoding('utf8');for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024){res.writeHead(413);return res.end('Payload too large')}}
 const sig=String(req.headers['x-webhook-signature']||''),ts=String(req.headers['x-webhook-timestamp']||'');
 if(!SASPAY_WEBHOOK_SECRET){res.writeHead(503);return res.end('Webhook secret not configured')}
 const expected=crypto.createHmac('sha256',SASPAY_WEBHOOK_SECRET).update(ts+'.'+raw,'utf8').digest('hex');
 const a=Buffer.from(sig.toLowerCase()),b=Buffer.from(expected);
 if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300||a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.writeHead(403);return res.end('Invalid signature')}
 try{
  const evt=JSON.parse(raw),name=String(evt.event||req.headers['x-webhook-event']||''),d=evt.data||{};
  if(/^transaction\.(success|failed|cancelled)$/.test(name)&&d.id){
   const order=await one('select * from saspay_orders where payment_id=?',String(d.id));
   if(order)await reconcileSaspayOrder(order,'webhook');
   else for(const o of await all("select * from saspay_orders where status='pending' and payment_id like 'cs:%' and created_at>fruty_ago(interval '3 hours') limit 20"))await reconcileSaspayOrder(o,'webhook');
  }
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('OK');
 }catch(err){console.error('SasPay webhook error:',err);res.writeHead(500);res.end('Processing error')}
}

/* ---- API ---- */
const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const readBody=(req,max=3e6)=>new Promise((ok,ko)=>{let d='';req.on('data',c=>{d+=c;if(d.length>max){ko(new E('Fichier trop volumineux',413));req.destroy()}});req.on('end',()=>{try{ok(d?JSON.parse(d):{})}catch{ko(new E('Requête invalide'))}})});
async function api(req,res,url){
 const p=url.pathname,post=req.method==='POST',b=post?await readBody(req,p==='/api/admin/pdf'?15e6:3e6):{},ip=req.socket.remoteAddress,tok=verify((req.headers.authorization||'').slice(7));
 const U=async()=>{if(!tok||tok.pre)throw new E('Non connecté',401);const u=await user(tok.sub);if(!u)throw new E('Non connecté',401);return u};
 const A=async()=>{const u=await U();if(u.role!=='admin'||!tok.adm)throw new E('Accès refusé',403);return u};
 const out=d=>send(res,200,{data:d,error:null});
 if(p==='/api/register'&&post){limit('r'+ip,10);const ph=String(b.phone||'').replace(/\D/g,''),pw=String(b.password||'');
  if(ph.length<8||ph.length>15)throw new E('Entrez un numéro de 8 à 15 chiffres.');if(pw.length<6||pw.length>100)throw new E('Mot de passe : 6 caractères minimum.');
  if(await one('select 1 from profiles where phone=?',ph))throw new E('Ce numéro a déjà un compte.');
  const inv=b.ref?await one('select id from profiles where code=?',String(b.ref).toUpperCase()):null;if(b.ref&&!inv)throw new E("Ce code d'invitation n'existe pas.");
  let code;do{code='SP'+crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(await one('select 1 from profiles where code=?',code));
  const id=uid();await run('insert into profiles(id,phone,hash,code,inviter) values(?,?,?,?,?)',id,ph,hashPw(pw),code,inv&&inv.id);return out({id,token:sign({sub:id},2592000)})}
 if(p==='/api/login'&&post){const ph=String(b.phone||'').replace(/\D/g,'');limit('l'+ip+ph);const u=await one('select * from profiles where phone=?',ph);
  if(!u||!checkPw(String(b.password||''),u.hash))throw new E('Téléphone ou mot de passe incorrect.',401);return out({id:u.id,token:sign({sub:u.id},2592000)})}
 if(p.startsWith('/api/t/')){const u=await U(),t=p.slice(7);if(!T[t])throw new E('Inconnu',404);await settlePurchaseRewards(u.id);const q=JSON.parse(url.searchParams.get('q')||'{}');let r=await T[t](u);
  for(const [k,v] of Object.entries(q.eq||{}))r=r.filter(x=>String(x[k])===String(v));
  if(q.order){const [c,d]=q.order;r.sort((x,y)=>(x[c]>y[c]?1:x[c]<y[c]?-1:0)*(d==='desc'?-1:1))}if(q.limit)r=r.slice(0,Math.min(+q.limit,200));
  return out(q.one?(r[0]||null):r)}
 if(p==='/api/config'){return out({...PUBLIC_LINKS,support_email:'sikaplus.con0125@gmail.com'})}
 if(p==='/api/deposit/methods'){await U();return out([1,2,3,4,5].map(n=>({method:n,available:DEPOSIT_METHODS[n]==='saspay'?!!SASPAY_API_KEY:DEPOSIT_METHODS[n]==='chariow'?!!(CHARIOW_API_KEY&&CHARIOW_PRODUCT_IDS[n]):false})))}
 if(p==='/api/deposit'&&post){limit('dep'+ip,8,60000);const u=await U(),amount=Math.floor(+b.amount),method=Math.floor(+b.method);
  if(!Number.isInteger(method)||method<1||method>5)throw new E('Choisissez une méthode de dépôt.');
  const provider=DEPOSIT_METHODS[method];
  if(provider==='saspay')return out(await createSaspayDeposit(u,req,amount,'auto',b.phone));
  if(provider==='chariow')return out(await createChariowDeposit(u,req,amount,method));
  throw new E('La méthode '+method+' sera bientôt disponible.',503)}
 if(p==='/api/saspay/deposit'&&post){limit('saspay'+ip,8,60000);const u=await U();return out(await createSaspayDeposit(u,req,Math.floor(+b.amount),String(b.network||''),b.phone))}
 if(p==='/api/saspay/status'&&!url.searchParams.get('order')){const u=await U();limit('spall'+u.id,30,60000);let credited=0,failed=0,pending=0,amount=0;for(const o of await all("select * from saspay_orders where user_id=? and status='pending' and created_at>fruty_ago(interval '2 days') order by created_at desc limit 8",u.id)){const st=await reconcileSaspayOrder(o,'poll');if(st==='completed'){credited++;amount+=o.amount}else if(st==='failed')failed++;else pending++}return out({credited,failed,pending,amount})}
 if(p==='/api/saspay/status'){const u=await U(),o=await one('select * from saspay_orders where id=? and user_id=?',String(url.searchParams.get('order')||''),u.id);if(!o)throw new E('Paiement introuvable',404);limit('spst'+u.id,60,60000);return out({status:await reconcileSaspayOrder(o,'poll')||o.status})}
 if(p==='/api/checkout/deposit'&&post){limit('chariow'+ip,8,60000);const u=await U(),amount=Math.floor(+b.amount),method=Math.floor(+b.method);return out(await createChariowDeposit(u,req,amount,method))}
 if(p.startsWith('/api/rpc/')&&post){const f=RPC[p.slice(9)];if(!f)throw new E('Inconnu',404);limit('x'+ip,120,60000);const u=await U();await settlePurchaseRewards(u.id);return out(await f(u,b))}
 /* --- admin : mot de passe + code TOTP obligatoires --- */
 if(p==='/api/admin/login'&&post){limit('a'+ip,6);const u=await one("select * from profiles where phone=? and role='admin'",String(b.phone||'').replace(/\D/g,''));
  if(!u||!checkPw(String(b.password||''),u.hash))throw new E('Identifiants incorrects.',401);
  if(!u.totp){const s=b32(crypto.randomBytes(20));await run('update profiles set totp=?,totp_ok=0 where id=?',s,u.id);u.totp=s}
  return out({tmp:sign({sub:u.id,pre:1},300),enroll:!u.totp_ok,secret:u.totp_ok?null:u.totp,uri:u.totp_ok?null:`otpauth://totp/Fruty:${u.phone}?secret=${u.totp}&issuer=Fruty`})}
 if(p==='/api/admin/totp'&&post){limit('t'+ip,6);const t=verify(b.tmp||''),u=t&&t.pre&&await user(t.sub);if(!u||u.role!=='admin')throw new E('Session expirée, reconnectez-vous.',401);
  if(!okTotp(u.totp,b.code))throw new E('Code incorrect.',401);await run('update profiles set totp_ok=1 where id=?',u.id);return out({token:sign({sub:u.id,adm:1},28800)})}
 if(p.startsWith('/api/admin/')){const admin=await A();const a=p.slice(11);
  if(a==='list'){const kind=url.searchParams.get('kind');if(kind==='questions'){const date=url.searchParams.get('date')||new Date().toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new E('Date invalide.');if(date===today())await tx(async()=>ensureDailyQuestions(date));return out(await L.questions(date))}return out(await (L[kind]||(()=>{throw new E('Inconnu',404)}))())}
  if(a==='decide'&&post){const dep=b.kind==='deposit';if(dep){const pending=await one("select * from deposits where id=? and status='attente'",b.id);if(pending&&(await one('select 1 from chariow_orders where deposit_ref=?',pending.ref)||await one('select 1 from saspay_orders where deposit_ref=?',pending.ref)))throw new E('Ce dépôt en ligne (Chariow/SasPay) est traité automatiquement après confirmation officielle du paiement. Aucune validation manuelle n’est autorisée.')}return out(await tx(async()=>{const x=await one(`select * from ${dep?'deposits':'withdrawals'} where id=? and status='attente'`,b.id);if(!x)throw new E('Introuvable ou déjà traité');
   await run(`update ${dep?'deposits':'withdrawals'} set status=? where id=?`,b.ok?'valide':'refuse',x.id);
   if(dep&&b.ok){await run('update profiles set wallet_sub=wallet_sub+? where id=?',x.amount,x.user_id);await led(x.user_id,'depot',x.amount)}
   if(!dep&&!b.ok)await run('update profiles set wallet_gain=wallet_gain+? where id=?',x.amount,x.user_id);
   await audit(admin,(dep?'deposit_':'withdrawal_')+(b.ok?'approved':'refused'),dep?'deposit':'withdrawal',x.id,{user_id:x.user_id,amount:x.amount},ip);return true}))}
  if(a==='user'&&post){return out(await tx(async()=>{const before=await one('select wallet_sub,wallet_gain,vip,active from profiles where id=?',String(b.id||''));if(!before)throw new E('Client introuvable.',404);
   const sub=Math.max(0,Math.floor(+b.sub)||0),gain=Math.max(0,Math.floor(+b.gain)||0),vip=Math.min(3,Math.max(0,Math.floor(+b.vip)||0)),active=b.active?1:0;
   await run('update profiles set wallet_sub=?,wallet_gain=?,vip=?,active=? where id=?',sub,gain,vip,active,b.id);
   if(sub!==before.wallet_sub)await led(b.id,'ajustement_achat',sub-before.wallet_sub);
   if(gain!==before.wallet_gain)await led(b.id,'ajustement_gain',gain-before.wallet_gain);
   await audit(admin,'user_adjust','profile',b.id,{before,after:{wallet_sub:sub,wallet_gain:gain,vip,active}},ip);return true}))}
  if(a==='product'&&post){let id=b.id;if(!id){id=uid();await run('insert into products(id,sym,name,hidden,pos) values(?,?,?,1,?)',id,'NEW','Nouveau produit',(await one('select count(*)+1 n from products')).n)}
   const accessDays=b.access_days==null||b.access_days===''?0:Number(b.access_days),dailyReward=b.daily_reward==null||b.daily_reward===''?0:Number(b.daily_reward);
   if(!Number.isInteger(accessDays)||!Number.isInteger(dailyReward)||accessDays<0||accessDays>3650||dailyReward<0||dailyReward>1000000||(accessDays===0&&dailyReward>0))throw new E('Durée ou récompense invalide. Une récompense exige une durée d’accès positive.');
   const priceNow=pint(b.price);if(dailyReward>0&&(!priceNow||dailyReward*accessDays>priceNow*MAX_REWARD_RATIO))throw new E('Crédits trop élevés : le total des crédits ('+(dailyReward*accessDays)+' F) ne doit pas dépasser '+Math.round(MAX_REWARD_RATIO*100)+' % du prix du produit.');
   const oldPdf=await one('select pdf_url from products where id=?',id),pdfUrl=String(b.pdf_url||'').trim().slice(0,500)||(oldPdf&&oldPdf.pdf_url)||'';
   await run('update products set name=?,sym=?,color=?,price=?,teaser=?,hidden=?,facts=?,body=?,pdf_url=?,access_days=?,daily_reward=? where id=?',String(b.name||'').slice(0,60),String(b.sym||'').toUpperCase().slice(0,5),hex(b.color),pint(b.price),String(b.teaser||'').slice(0,300),b.hidden?1:0,String(b.facts||''),String(b.body||''),pdfUrl,accessDays,dailyReward,id);await audit(admin,'product_save','product',id,{price:pint(b.price),access_days:accessDays,daily_reward:dailyReward,hidden:b.hidden?1:0},ip);return out(id)}
  if(a==='question'&&post)throw new E('Les questions sont maintenant tirées automatiquement de la banque de 50 questions.');
  if(a==='pdf'&&post){const m=/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl||'');if(!m||!await one('select 1 from products where id=?',b.id))throw new E('Fichier PDF ou produit invalide.');const buf=Buffer.from(m[1],'base64');if(buf.length<8||buf.length>10*1024*1024||buf.subarray(0,5).toString()!=='%PDF-')throw new E('Le PDF doit être valide et faire 10 Mo maximum.');await tx(async()=>{await run('insert into product_files(product_id,data,size,updated_at) values(?,?,?,fruty_now()) on conflict(product_id) do update set data=excluded.data,size=excluded.size,updated_at=excluded.updated_at',b.id,buf,buf.length);await run('update products set pdf_url=? where id=?','/private-pdf/'+b.id,b.id)});return out(true)}
  if(a==='image'&&post){const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl||'');if(!m||!await one('select 1 from products where id=?',b.id))throw new E('Image invalide (PNG, JPG ou WebP).');
   const buf=Buffer.from(m[2],'base64');if(buf.length>2e6)throw new E('Image trop lourde (2 Mo max).');const f=`${b.id}-${Date.now()}.${m[1]==='jpeg'?'jpg':m[1]}`;await run('insert into product_images(filename,mime,data) values(?,?,?)',f,'image/'+m[1],buf);await run('update products set image_url=? where id=?','/uploads/'+f,b.id);return out('/uploads/'+f)}
  if(a==='options'&&post){const rows=(b.rows||[]).map(r=>({amount:Math.floor(+r.amount),label:String(r.label||'').slice(0,40),pay_url:/^https?:\/\//.test(r.pay_url||'')?String(r.pay_url).slice(0,500):''}));
   if(!rows.length||rows.some(r=>!(r.amount>=100))||new Set(rows.map(r=>r.amount)).size!==rows.length)throw new E('Montants invalides ou en double (minimum 100 FCFA).');
   await tx(async()=>{await run('delete from deposit_options');for(const r of rows)await run('insert into deposit_options values(?,?,?)',r.amount,r.label,r.pay_url)});return out(true)}
  if(a==='announce'&&post){if(b.del)await run('delete from announcements where id=?',b.id);else{if(!String(b.title||'').trim())throw new E('Titre requis');await run('insert into announcements(id,title,body) values(?,?,?)',uid(),String(b.title).slice(0,120),String(b.body||'').slice(0,1000))}return out(true)}}
 throw new E('Introuvable',404)}

/* ---- PDF privés : chaque ouverture revérifie le compte et l'accès en cours ---- */
async function servePrivatePdf(req,res,url){
 if(req.method!=='GET'){res.writeHead(405,{'Allow':'GET','Cache-Control':'no-store'});return res.end('Méthode non autorisée');}
 const tok=verify((req.headers.authorization||'').slice(7));if(!tok||tok.pre){res.writeHead(401,{'Cache-Control':'no-store'});return res.end('Connexion requise');}
 const u=await user(tok.sub);if(!u){res.writeHead(401,{'Cache-Control':'no-store'});return res.end('Connexion requise');}
 const productId=decodeURIComponent(url.pathname.slice('/private-pdf/'.length));
 if(!/^[a-zA-Z0-9-]{8,80}$/.test(productId)){res.writeHead(404);return res.end('PDF introuvable');}
 if(u.role!=='admin'){
  await settlePurchaseRewards(u.id);
  const access=await one("select 1 from product_accesses where user_id=? and product_id=? and (expires_at is null or expires_at>fruty_now())",u.id,productId);
  if(!access){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end('Votre accès à ce PDF est expiré ou indisponible.');}
 }
 const product=await one('select pdf_url from products where id=?',productId),file=product&&product.pdf_url==='/private-pdf/'+productId?await one('select data from product_files where product_id=?',productId):null;
 if(!file){res.writeHead(404,{'Cache-Control':'no-store'});return res.end('PDF introuvable');}
 res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Fruty-document.pdf"','Content-Length':file.data.length,'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'});res.end(file.data);
}

/* ---- images produits (stockées en base : le disque de Render Free est éphémère) ---- */
async function serveUpload(res,url){let f='';try{f=decodeURIComponent(url.pathname.slice(9))}catch{}
 const img=/^[\w.-]{1,120}$/.test(f)?await one('select mime,data from product_images where filename=?',f):null;
 if(!img){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Page introuvable')}
 res.writeHead(200,{'Content-Type':img.mime,'Content-Length':img.data.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'public, max-age=86400'});res.end(img.data)}

/* ---- fichiers statiques + en-têtes de sécurité ---- */
const MIME={'.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.json':'application/json','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
function serve(res,url){const up=url.pathname.startsWith('/uploads/'),root=up?UP:PUB;let rel=up?url.pathname.slice(9):url.pathname==='/'?'client.html':url.pathname==='/gestion'?'admin.html':url.pathname.slice(1);
 let fp;try{fp=path.resolve(root,decodeURIComponent(rel))}catch{fp=''}
 if(!fp.startsWith(root+path.sep)||!fs.existsSync(fp)||!fs.statSync(fp).isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Page introuvable')}
 const h={'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(path.extname(fp)==='.html'){h['Content-Security-Policy']=CSP;h['Cache-Control']='no-cache';if(rel==='admin.html')h['X-Robots-Tag']='noindex'}else h['Cache-Control']='public, max-age=86400';
 res.writeHead(200,h);fs.createReadStream(fp).pipe(res)}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://x');
 try{if(url.pathname==='/webhooks/chariow'&&req.method==='POST')await chariowWebhook(req,res);else if(url.pathname==='/webhooks/saspay'&&req.method==='POST')await saspayWebhook(req,res);else if(url.pathname.startsWith('/api/'))await api(req,res,url);else if(url.pathname.startsWith('/private-pdf/'))await servePrivatePdf(req,res,url);else if(url.pathname.startsWith('/uploads/'))await serveUpload(res,url);else serve(res,url)}
 catch(e){if(!(e instanceof E))console.error(e);send(res,e instanceof E?e.c:500,{data:null,error:{message:e instanceof E?e.message:'Erreur du serveur'}})}});

/* ---- premier démarrage : migrations, produits, administrateur (via variables d'environnement) ---- */
async function init(){
 await db.migrate();
 if(!SECRET){
  await run("insert into app_secrets(name,value) values('session_secret',?) on conflict do nothing",crypto.randomBytes(48).toString('hex'));
  SECRET=(await one("select value from app_secrets where name='session_secret'")).value;
 }
 await seedQuestionBank();
 if(!await one('select 1 from products')){for(const [i,r] of [['BTC','Bitcoin','#F7931A',4000,'La première cryptomonnaie, souvent comparée à de l\'or numérique.'],['ETH','Ethereum','#627EEA',10000,'La plateforme des contrats intelligents.'],['USDT','Tether','#26A17B',18000,'Un stablecoin conçu pour valoir 1 dollar.'],['BNB','BNB','#F3BA2F',null,'Le jeton de l\'écosystème Binance.'],['XRP','XRP','#3B4A63',null,'Pensée pour les paiements internationaux.'],['SOL','Solana','#9945FF',null,'Une blockchain rapide aux frais très bas.'],['USDC','USD Coin','#2775CA',null,'Un stablecoin en dollars émis par Circle.'],['TRX','TRON','#EB0029',null,'Très utilisée pour envoyer de l\'USDT.'],['DOGE','Dogecoin','#C2A633',null,'Née d\'une blague, devenue très connue.'],['ADA','Cardano','#2A5ADA',null,'Une blockchain bâtie sur la recherche.']].entries())await run('insert into products(id,sym,name,color,price,teaser,pos) values(?,?,?,?,?,?,?)',uid(),r[0],r[1],r[2],r[3],r[4],i+1)}
 const AP=String(process.env.ADMIN_PHONE||'').replace(/\D/g,''),AW=process.env.ADMIN_PASSWORD||'';
 if(AP&&AW.length>=10&&!await one('select 1 from profiles where phone=?',AP)){let ac='SPADMIN';while(await one('select 1 from profiles where code=?',ac))ac='SP'+crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();await run("insert into profiles(id,phone,hash,role,code,active) values(?,?,?,'admin',?,1)",uid(),AP,hashPw(AW),ac)}
 if(!await one("select 1 from profiles where role='admin'"))console.log("⚠ Aucun administrateur. Définissez ADMIN_PHONE et ADMIN_PASSWORD (10 caractères minimum) puis redémarrez.");
}
const ready=init();
if(require.main===module){
 ready.then(()=>{
  server.listen(PORT,()=>console.log(`Fruty prêt : http://localhost:${PORT}  (admin : /gestion)`));
  const settle=()=>settleAllPurchaseRewards().catch(e=>console.error('Erreur de traitement des crédits PDF :',e));
  settle();const rewardTimer=setInterval(settle,60_000);rewardTimer.unref();
 }).catch(e=>{console.error('Démarrage impossible :',e.message);process.exit(1)});
}
module.exports={server,totp,b32,ready,db};
