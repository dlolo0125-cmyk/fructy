'use strict';
/* Fruty : serveur autonome, zéro dépendance. Node >= 22.13. Lancer : node server.js */
const {DatabaseSync}=require('node:sqlite'),http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,PUBLIC_LINKS=Object.freeze({channel_url:(()=>{try{const u=new URL(process.env.FRUTY_CHANNEL_URL||'');return /^https?:$/.test(u.protocol)?u.toString():''}catch{return ''}})(),assistant_url:(()=>{try{const u=new URL(process.env.FRUTY_ASSISTANT_URL||'');return /^https?:$/.test(u.protocol)?u.toString():''}catch{return ''}})()}),DEPOSIT_METHODS=Object.freeze(Object.fromEntries([1,2,3,4,5].map(n=>[n,(process.env['DEPOSIT_METHOD_'+n]||(n===1?'chariow':n===2?'saspay':'')).toLowerCase()]))),SASPAY_API_KEY=process.env.SASPAY_API_KEY||'',SASPAY_WEBHOOK_SECRET=process.env.SASPAY_WEBHOOK_SECRET||'',SASPAY_BASE=(process.env.SASPAY_BASE_URL||((process.env.SASPAY_API_KEY||'').startsWith('sk_test_')?'https://sandbox-api.saspay.me/api/v1':'https://api.saspay.me/api/v1')).replace(/\/$/,''),SASPAY_NETWORKS=Object.freeze({'T-Money':process.env.SASPAY_NETWORK_TMONEY||'tmoney_tg','Flooz':process.env.SASPAY_NETWORK_FLOOZ||'moov_tg'}),CHARIOW_API_KEY=process.env.CHARIOW_API_KEY||'',DEPOSIT_MIN=1000,DEPOSIT_MAX=100000,CHARIOW_AMOUNTS=Object.freeze([1000,2000,5000,10000,20000]),SASPAY_MAX=10000,CHARIOW_PRODUCT_BY_AMOUNT=Object.freeze({1000:process.env.CHARIOW_PRODUCT_ID_1000||process.env.CHARIOW_PRODUCT_ID||'prd_qc1stvd5',2000:process.env.CHARIOW_PRODUCT_ID_2000||'prd_yl93dwer',5000:process.env.CHARIOW_PRODUCT_ID_5000||'prd_lie65vzx',10000:process.env.CHARIOW_PRODUCT_ID_10000||'prd_g00q5t16',20000:process.env.CHARIOW_PRODUCT_ID_20000||'prd_vw27ffj5'}),CHARIOW_PRODUCT_IDS=Object.freeze(Object.fromEntries([1,2,3,4,5].map(n=>[n,process.env['CHARIOW_PRODUCT_ID_M'+n]||process.env.CHARIOW_PRODUCT_ID||'prd_qc1stvd5']))),CHARIOW_PULSE_SECRET=process.env.CHARIOW_PULSE_SECRET||'',APP_BASE_URL=(process.env.APP_BASE_URL||'').replace(/\/$/,''),DATA=process.env.DATA_DIR||path.join(__dirname,'data'),PUB=path.join(__dirname,'public'),UP=path.join(DATA,'uploads'),PDF=path.join(DATA,'private-pdfs');
fs.mkdirSync(UP,{recursive:true});fs.mkdirSync(PDF,{recursive:true});
const kf=path.join(DATA,'secret.key');if(!fs.existsSync(kf))fs.writeFileSync(kf,crypto.randomBytes(48).toString('hex'),{mode:0o600});
const SECRET=process.env.SECRET||fs.readFileSync(kf,'utf8').trim();
const db=new DatabaseSync(path.join(DATA,'sikaplus.db'));db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;');
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
db.exec(`
create table if not exists profiles(id text primary key,phone text unique not null,hash text not null,role text not null default 'client',code text unique not null,inviter text,
 wallet_sub integer not null default 0 check(wallet_sub>=0),wallet_gain integer not null default 0 check(wallet_gain>=0),vip integer not null default 0,active integer not null default 0,
 nom text,prenom text,email text,method text,paynum text,totp text,totp_ok integer not null default 0,created_at text default(${NOW}));
create table if not exists products(id text primary key,sym text not null,name text not null,color text default '#7C3AED',price integer,teaser text,image_url text,hidden integer not null default 0,pos integer default 0,facts text,body text,pdf_url text);
create table if not exists deposit_options(amount integer primary key,label text,pay_url text);
create table if not exists deposits(id text primary key,user_id text not null,amount integer not null,ref text unique not null,status text not null default 'attente',created_at text default(${NOW}));
create table if not exists withdrawals(id text primary key,user_id text not null,amount integer not null,method text,dest text,status text not null default 'attente',created_at text default(${NOW}));
create table if not exists purchases(user_id text,product_id text,price integer,created_at text default(${NOW}),primary key(user_id,product_id));
create table if not exists task_log(user_id text,day text,task_id text,primary key(user_id,day,task_id));
create table if not exists ledger(id integer primary key autoincrement,user_id text,kind text,amount integer,created_at text default(${NOW}));
create table if not exists announcements(id text primary key,title text,body text,created_at text default(${NOW}));`);
const {applyMigrations}=require('./backend/database/migrate');
const migrationResult=applyMigrations(db,DATA);
if(migrationResult.applied)console.log('Schéma pédagogique Fruty V2 installé.');
const all=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a)??null,run=(s,...a)=>db.prepare(s).run(...a);
class E extends Error{constructor(m,c){super(m);this.c=c||400}}
const tx=f=>{db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};
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
function seedQuestionBank(){QUESTION_BANK.forEach((q,i)=>run('insert or ignore into question_bank(id,prompt,options_json,correct_option,explanation) values(?,?,?,?,?)',i+1,q[0],JSON.stringify(q[1]),q[2],q[3]||''))}
function ensureDailyQuestions(day){/* sans transaction propre : l'appelant gère la transaction (Node est mono-thread) */
 const now=one('select count(*) c from daily_questions where question_date=? and active=1',day).c;if(now>=DAILY_QUESTIONS)return;
 const picks=all('select * from question_bank where prompt not in (select prompt from daily_questions where question_date=?) order by coalesce(last_used_date,\'\') asc,random() limit ?',day,DAILY_QUESTIONS-now);
 let order=one('select coalesce(max(sort_order),0) n from daily_questions where question_date=?',day).n;
 picks.forEach(q=>{run('insert into daily_questions(id,question_date,prompt,options_json,correct_option,explanation,sort_order) values(?,?,?,?,?,?,?)',uid(),day,q.prompt,q.options_json,q.correct_option,q.explanation,++order);run('update question_bank set last_used_date=? where id=?',day,q.id)})}
const today=()=>new Date().toISOString().slice(0,10);
function bonusState(p){
 const claimed=k=>one('select amount,claimed_at from user_bonuses where user_id=? and kind=?',p.id,k),w=claimed('welcome'),b=claimed('purchase');
 const deadline=new Date(new Date(p.created_at).getTime()+BONUS_WINDOW_DAYS*864e5).toISOString();
 const bought=one('select 1 x from product_accesses where user_id=? and purchased_at<=? limit 1',p.id,deadline);
 const purchase=b?'claimed':bought?'available':(new Date()>new Date(deadline)?'expired':'locked');
 return {welcome_amount:WELCOME_GIFT,welcome_claimed:w?1:0,purchase_amount:PURCHASE_BONUS,purchase_state:purchase,purchase_deadline:deadline,window_days:BONUS_WINDOW_DAYS}}
const audit=(admin,action,type,target,details,ip)=>run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,?,?,?,?,?,?)',uid(),admin.id,action,type,String(target||''),JSON.stringify(details||{}),ip||null);
// Garde-fou : le total des crédits promotionnels d'un PDF doit rester strictement inférieur à son prix.
const MAX_REWARD_RATIO=0.5;
// Le premier crédit PDF est dû à l'achat, puis les suivants toutes les 24 heures.
// La contrainte UNIQUE(access_id, reward_number) garantit l'idempotence même après plusieurs connexions.
const settlePurchaseRewards=userId=>tx(()=>{
 const now=Date.now(),rows=all('select * from product_accesses where user_id=? and access_days>0 and daily_reward>0',userId);
 for(const a of rows){const start=Date.parse(a.purchased_at);if(!Number.isFinite(start))continue;
  for(let n=1;n<=a.access_days;n++){
   if(start+(n-1)*86400000>now)break;
   if(one('select 1 from product_reward_credits where access_id=? and reward_number=?',a.id,n))continue;
   run('insert into product_reward_credits(id,access_id,user_id,reward_number,amount) values(?,?,?,?,?)',uid(),a.id,userId,n,a.daily_reward);
   run('update profiles set wallet_sub=wallet_sub+? where id=?',a.daily_reward,userId);
   led(userId,'recompense_pdf',a.daily_reward);
  }
 }
});
const settleAllPurchaseRewards=()=>{for(const row of all('select distinct user_id from product_accesses where access_days>0 and daily_reward>0'))settlePurchaseRewards(row.user_id)};
const RPC={
 update_profile:(u,{n,pn,em,mt,pay})=>{if(user(u.id).active)throw new E('Votre compte est déjà activé. Pour modifier vos informations, contactez le support : sikaplus.con0125@gmail.com.');if(String(n||'').trim().length<2||String(pn||'').trim().length<2||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em||'')||String(pay||'').trim().length<4)throw new E('Informations invalides');
  run('update profiles set nom=?,prenom=?,email=?,method=?,paynum=?,active=1 where id=?',String(n).trim().slice(0,60),String(pn).trim().slice(0,60),String(em).slice(0,120),String(mt||'').slice(0,30),String(pay).trim().slice(0,40),u.id);return true},
 submit_deposit:(u,{a,r})=>tx(()=>{const p=act(user(u.id));a=Math.floor(+a);r=String(r||'').trim().toLowerCase();
  if(!Number.isInteger(a)||a<DEPOSIT_MIN||a>DEPOSIT_MAX)throw new E('Le montant doit être compris entre 1 000 et 100 000 FCFA.');if(r.length<4||r.length>60||(r.startsWith('chariow:')||r.startsWith('saspay:')))throw new E('Référence invalide.');
  if(one('select 1 from deposits where ref=?',r))throw new E('Cette référence a déjà été utilisée');run('insert into deposits(id,user_id,amount,ref) values(?,?,?,?)',uid(),p.id,a,r);return true}),
 request_withdrawal:(u,{a,m,d})=>tx(()=>{const p=act(user(u.id));a=Math.floor(+a);
  if(!(a>=500))throw new E('Retrait minimum : 500 FCFA');if(a>p.wallet_gain)throw new E('Gains insuffisants');if(String(d||'').replace(/\D/g,'').length<8)throw new E('Numéro de réception invalide');
  run('update profiles set wallet_gain=wallet_gain-? where id=?',a,p.id);run('insert into withdrawals(id,user_id,amount,method,dest) values(?,?,?,?,?)',uid(),p.id,a,String(m||'').slice(0,30),String(d).slice(0,30));led(p.id,'retrait',a);return true}),
 buy_product:(u,{pid})=>tx(()=>{const p=act(user(u.id)),x=one('select price,access_days,daily_reward from products where id=? and hidden=0',pid);
  if(!x||!x.price)throw new E('Produit indisponible');
  const active=one("select 1 from product_accesses where user_id=? and product_id=? and (expires_at is null or expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",p.id,pid);
  if(active)throw new E('Vous avez déjà un accès actif à ce PDF.');if(p.wallet_sub<x.price)throw new E('Solde insuffisant');
  const days=Math.max(0,Math.floor(x.access_days||0)),reward=Math.max(0,Math.floor(x.daily_reward||0));
  if(days===0&&reward>0)throw new E('Une récompense journalière exige une durée d’accès définie.');
  const purchasedAt=new Date().toISOString(),expiresAt=days?new Date(Date.now()+days*86400000).toISOString():null;
  run('update profiles set wallet_sub=wallet_sub-? where id=?',x.price,p.id);
  run('insert into product_accesses(id,user_id,product_id,price,access_days,daily_reward,purchased_at,expires_at) values(?,?,?,?,?,?,?,?)',uid(),p.id,pid,x.price,days,reward,purchasedAt,expiresAt);
  run('insert or ignore into purchases(user_id,product_id,price,created_at) values(?,?,?,?)',p.id,pid,x.price,purchasedAt);led(p.id,'achat',x.price);return {expires_at:expiresAt,access_days:days,daily_reward:reward}}),
 set_vip:(u,{n})=>tx(()=>{const p=act(user(u.id));n=Math.floor(+n);if(!(n>p.vip&&n<=3))throw new E('Niveau invalide');if(p.wallet_sub<VIP[n])throw new E('Solde insuffisant');
  run('update profiles set wallet_sub=wallet_sub-?,vip=? where id=?',VIP[n],n,p.id);led(p.id,'vip',VIP[n]);return true}),
 claim_welcome:u=>tx(()=>{const p=act(user(u.id));if(one("select 1 from user_bonuses where user_id=? and kind='welcome'",p.id))throw new E('Le cadeau de bienvenue a déjà été récupéré.');run("insert into user_bonuses(user_id,kind,amount) values(?,'welcome',?)",p.id,WELCOME_GIFT);run('update profiles set wallet_sub=wallet_sub+? where id=?',WELCOME_GIFT,p.id);led(p.id,'bienvenue',WELCOME_GIFT);return {amount:WELCOME_GIFT}}),
 claim_purchase_bonus:u=>tx(()=>{const p=act(user(u.id)),st=bonusState(p);if(st.purchase_state==='claimed')throw new E('Ce bonus a déjà été récupéré.');if(st.purchase_state==='expired')throw new E('Ce bonus a expiré : il fallait acheter un produit dans les '+BONUS_WINDOW_DAYS+' jours suivant la création du compte.');if(st.purchase_state!=='available')throw new E('Achetez un produit dans les '+BONUS_WINDOW_DAYS+' jours suivant la création de votre compte pour débloquer ce bonus.');run("insert into user_bonuses(user_id,kind,amount) values(?,'purchase',?)",p.id,PURCHASE_BONUS);run('update profiles set wallet_sub=wallet_sub+? where id=?',PURCHASE_BONUS,p.id);led(p.id,'bonus_achat',PURCHASE_BONUS);return {amount:PURCHASE_BONUS}}),
 answer_daily_question:(u,{qid,choice})=>tx(()=>{const p=act(user(u.id)),day=today();ensureDailyQuestions(day);if(one('select count(*) c from daily_questions where question_date=? and active=1',day).c!==DAILY_QUESTIONS)throw new E('Les questions du jour ne sont pas encore disponibles.');const q=one('select * from daily_questions where id=? and question_date=? and active=1',String(qid||''),day);
  if(!q)throw new E('Cette question n’est plus disponible.');
  if(one('select 1 from daily_question_answers where user_id=? and question_id=?',p.id,q.id))throw new E('Vous avez déjà répondu à cette question.');
  const options=JSON.parse(q.options_json);choice=Number(choice);if(!Number.isInteger(choice)||choice<0||choice>=options.length)throw new E('Réponse invalide.');
  const correct=choice===q.correct_option,reward=correct?QUESTION_REWARD:0;
  run('insert into daily_question_answers(id,user_id,question_id,question_date,selected_option,is_correct,reward_amount) values(?,?,?,?,?,?,?)',uid(),p.id,q.id,day,choice,correct?1:0,reward);
  if(reward){run('update profiles set wallet_sub=wallet_sub+? where id=?',reward,p.id);led(p.id,'question',reward)}
  return {correct,reward,explanation:q.explanation||''}}),
 my_team:u=>all("select substr(phone,1,3)||'•••'||substr(phone,-2) phone,created_at from profiles where inviter=? order by created_at desc",u.id)
};
/* lecture : chaque client ne voit que ses propres lignes ; le contenu payant seulement s'il est acheté */
const T={
 profiles:u=>all('select id,phone,role,code,wallet_sub,wallet_gain,vip,active,nom,prenom,email,method,paynum,created_at from profiles where id=?',u.id),
 products:()=>all('select id,sym,name,color,price,teaser,image_url,pos,access_days,daily_reward from products where hidden=0 order by pos'),
 product_content:u=>all("select p.id product_id,p.facts,p.body,p.pdf_url from products p join product_accesses a on a.product_id=p.id where a.user_id=? and (a.expires_at is null or a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) order by a.purchased_at desc",u.id),
 deposit_options:()=>[1,2,3,4,5].map(n=>({method:n,label:'Méthode '+n})),
 deposits:u=>all('select id,amount,ref,status,created_at from deposits where user_id=?',u.id),
 withdrawals:u=>all('select id,amount,method,dest,status,created_at from withdrawals where user_id=?',u.id),
 purchases:u=>all("select a.id,a.product_id,p.name,p.sym,p.image_url,a.price,a.purchased_at created_at,a.expires_at,a.access_days,a.daily_reward,(select count(*) from product_reward_credits rc where rc.access_id=a.id) rewards_paid_count,(select coalesce(sum(amount),0) from product_reward_credits rc where rc.access_id=a.id) rewards_paid,case when a.expires_at is null or a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') then 1 else 0 end active from product_accesses a join products p on p.id=a.product_id where a.user_id=? order by a.purchased_at desc",u.id),
 daily_questions:u=>{tx(()=>ensureDailyQuestions(today()));return all("select q.id,q.question_date,q.prompt,q.options_json,q.sort_order,case when a.id is null then 0 else 1 end answered,case when a.id is null then null else a.is_correct end is_correct,case when a.id is null then 0 else a.reward_amount end reward_amount,case when a.id is null then '' else q.explanation end explanation from daily_questions q left join daily_question_answers a on a.question_id=q.id and a.user_id=? where q.question_date=? and q.active=1 order by q.sort_order",u.id,today())},
 bonuses:u=>[bonusState(user(u.id))],
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
 purchases:()=>all("select a.id,a.user_id,pf.phone,pr.name product_name,a.price,a.purchased_at,a.expires_at,a.access_days,a.daily_reward,(select count(*) from product_reward_credits rc where rc.access_id=a.id) rewards_paid_count,(select coalesce(sum(amount),0) from product_reward_credits rc where rc.access_id=a.id) rewards_paid from product_accesses a join profiles pf on pf.id=a.user_id join products pr on pr.id=a.product_id order by a.purchased_at desc limit 300"),
 questions:date=>all('select q.id,q.question_date,q.prompt,q.options_json,q.correct_option,q.explanation,q.sort_order,q.active,(select count(*) from daily_question_answers a where a.question_id=q.id) answer_count from daily_questions q where q.question_date=? order by q.sort_order',date),
 announcements:()=>all('select * from announcements order by created_at desc')
};

/* ---- Paiement Chariow : le serveur préremplit le checkout et le Pulse confirme le crédit ---- */
async function createChariowDeposit(u, req, amount, method) {
 if(!Number.isInteger(amount)||amount<DEPOSIT_MIN||amount>DEPOSIT_MAX)throw new E('Le montant du dépôt doit être compris entre 1 000 et 100 000 FCFA.');
 if(!CHARIOW_AMOUNTS.includes(amount))throw new E('Choisissez un des montants proposés : 1 000, 2 000, 5 000, 10 000 ou 20 000 FCFA.');
 if(!Number.isInteger(method)||method<1||method>5)throw new E('Choisissez une méthode de dépôt (Méthode 1 à Méthode 5).');
 const p=act(user(u.id)),productId=CHARIOW_PRODUCT_BY_AMOUNT[amount];
 if(!CHARIOW_API_KEY||!productId)throw new E('La méthode '+method+' n’est pas encore configurée par l’administrateur.',503);
 if(!p.nom||!p.prenom||!p.email||!p.method||!p.paynum)throw new E('Complétez d’abord vos informations dans Paramètres pour continuer.');
 const mobile=['T-Money','Flooz'].includes(p.method),buyerPhone=mobile?p.paynum:p.phone;
 let number=String(buyerPhone||'').replace(/\D/g,'');
 if(number.startsWith('228')&&number.length===11)number=number.slice(3);
 if(number.length<8||number.length>15)throw new E('Le numéro de téléphone du payeur est invalide.');
 const id=uid(),depositRef='chariow:'+id;
 tx(()=>{
  run('insert into chariow_orders(id,user_id,amount,product_id,deposit_ref) values(?,?,?,?,?)',id,p.id,amount,productId,depositRef);
  run('insert into deposits(id,user_id,amount,ref,status) values(?,?,?,?,?)',uid(),p.id,amount,depositRef,'attente');
 });
 const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
 const payload={product_id:productId,amount,email:p.email,first_name:p.prenom,last_name:p.nom,
  phone:{number,country_code:'TG'},payment_currency:'XOF',
  custom_metadata:{sikaplus_order_id:id,sikaplus_user_id:p.id,sikaplus_amount:String(amount),sikaplus_deposit_method:String(method),sikaplus_payment_method:p.method,sikaplus_payment_number:number}};
 if(forwarded && /^[0-9a-f:.]+$/i.test(forwarded))payload.customer_ip=forwarded;
 {const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim(),proto=String(req.headers['x-forwarded-proto']||'https').split(',')[0].trim()==='http'?'http':'https',base=APP_BASE_URL||(/^[a-z0-9.\-]+(:\d{2,5})?$/i.test(host)?proto+'://'+host:'');if(base)payload.redirect_url=base+'/?payment=chariow&order='+id+'#depot'}
 try{
  const response=await fetch('https://api.chariow.com/v1/checkout',{method:'POST',headers:{Authorization:'Bearer '+CHARIOW_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.message||JSON.stringify(result.errors||'Erreur API Chariow'));
  const data=result.data||result,checkoutUrl=String(data.payment&&data.payment.checkout_url||'');
  let parsedCheckoutUrl=null;try{parsedCheckoutUrl=new URL(checkoutUrl)}catch{}
  if(data.step!=='payment'||!data.payment||!parsedCheckoutUrl||parsedCheckoutUrl.protocol!=='https:'||parsedCheckoutUrl.username||parsedCheckoutUrl.password)throw new Error('Chariow n’a pas retourné une URL de paiement HTTPS valide. Vérifiez le produit et son prix.');
  run('update chariow_orders set sale_id=?,transaction_id=? where id=?',data.purchase&&data.purchase.id||null,data.payment.transaction_id||null,id);
  return {checkout_url:parsedCheckoutUrl.toString(),order_id:id};
 }catch(err){
  tx(()=>{run("update chariow_orders set status='failed' where id=?",id);run("update deposits set status='refuse' where ref=?",depositRef)});
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
  const outcome=tx(()=>{
   if(one('select 1 from chariow_pulse_deliveries where delivery_id=?',delivery))return 'duplicate';
   const sale=payload.sale||{},product=payload.product||{},meta=sale.custom_metadata||{};
   const saleId=String(sale.id||''),orderId=String(meta.sikaplus_order_id||'');
   if(event!=='successful.sale'){
    run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,orderId||null,'ignored_event');
    return 'ignored_event';
   }
   // L'identifiant de commande est la clé de rapprochement principale. Le sale_id
   // seul n'est jamais suffisant pour choisir le compte à créditer.
   const order=orderId?one('select * from chariow_orders where id=?',orderId):null;
   if(!order){
    run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,orderId||null,'order_not_found');
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
    run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId||null,order.id,'rejected_mismatch');
    console.warn('Chariow Pulse: notification non concordante', {delivery_id:delivery,order_id:order.id,order_status:order.status,product_matches:productMatches,metadata_matches:metadataMatches,payment_matches:paymentMatches,sale_matches:saleMatches});
    return 'rejected_mismatch';
   }
   const dep=one("select id,user_id,amount,status from deposits where ref=?",order.deposit_ref);
   if(!dep||dep.user_id!==order.user_id||dep.amount!==order.amount||dep.status!=='attente'){
    run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId,order.id,'deposit_not_pending');
    console.warn('Chariow Pulse: dépôt associé absent ou incohérent', {delivery_id:delivery,order_id:order.id});
    return 'deposit_not_pending';
   }
   // La transaction SQLite BEGIN IMMEDIATE et les statuts pending/attente
   // rendent le crédit atomique et idempotent, y compris en cas de requêtes concurrentes.
   run("update deposits set status='valide' where id=? and status='attente'",dep.id);
   if(db.prepare('select changes() n').get().n!==1)throw new Error('Le dépôt a déjà été traité');
   run('update profiles set wallet_sub=wallet_sub+? where id=?',order.amount,order.user_id);
   led(order.user_id,'depot',order.amount);
   run("update chariow_orders set sale_id=coalesce(sale_id,?),status='completed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and status='pending'",saleId,order.id);
   if(db.prepare('select changes() n').get().n!==1)throw new Error('La commande Chariow a déjà été traitée');
   run('insert into chariow_pulse_deliveries(delivery_id,event_name,sale_id,order_id,outcome) values(?,?,?,?,?)',delivery,event,saleId,order.id,'credited');
   run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,NULL,?,?,?,?,?)',uid(),'chariow_auto_credit','chariow_order',order.id,JSON.stringify({user_id:order.user_id,amount:order.amount,currency:'XOF',sale_id:saleId,delivery_id:delivery}),null);
   return 'credited';
  });
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(outcome==='credited'?'OK':outcome==='duplicate'?'OK':'IGNORED');
 }catch(err){console.error('Chariow Pulse processing error:',err);res.writeHead(500);res.end('Processing error')}
}

/* ---- Paiement SasPay (Softpay) : numéro + réseau + montant ; nom/prénom/email viennent du profil activé ---- */
const spHeaders=extra=>({Authorization:'Bearer '+SASPAY_API_KEY,'Content-Type':'application/json',...extra});
const spData=j=>(j&&j.data&&typeof j.data==='object')?j.data:(j||{});
function normTogoPhone(v){let n=String(v||'').replace(/\D/g,'');if(n.startsWith('00228'))n=n.slice(5);if(n.startsWith('228')&&n.length===11)n=n.slice(3);return /^\d{8}$/.test(n)?n:null}
function creditSaspayOrder(orderId,source){
 return tx(()=>{
  const order=one('select * from saspay_orders where id=?',orderId);
  if(!order||order.status!=='pending')return 'already';
  const dep=one("select id from deposits where ref=? and status='attente'",order.deposit_ref);
  if(!dep)return 'deposit_not_pending';
  run("update deposits set status='valide' where id=? and status='attente'",dep.id);
  run('update profiles set wallet_sub=wallet_sub+? where id=?',order.amount,order.user_id);
  led(order.user_id,'depot',order.amount);
  run("update saspay_orders set status='completed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=? and status='pending'",order.id);
  run('insert into admin_audit_logs(id,admin_id,action,target_type,target_id,details_json,ip_address) values(?,NULL,?,?,?,?,?)',uid(),'saspay_auto_credit','saspay_order',order.id,JSON.stringify({user_id:order.user_id,amount:order.amount,currency:'XOF',payment_id:order.payment_id,source}),null);
  return 'credited';
 });
}
function failSaspayOrder(orderId){
 return tx(()=>{const o=one('select * from saspay_orders where id=?',orderId);if(!o||o.status!=='pending')return false;
  run("update saspay_orders set status='failed' where id=? and status='pending'",o.id);run("update deposits set status='refuse' where ref=? and status='attente'",o.deposit_ref);return true});
}
/* Vérifie l'état réel auprès de SasPay puis crédite ou refuse. Appelé par le webhook ET par le suivi du client. */
async function reconcileSaspayOrder(order,source){
 if(!order||order.status!=='pending'||!order.payment_id)return order&&order.status;
 if(order.payment_id.startsWith('cs:')){
  let sd;
  try{const r=await fetch(SASPAY_BASE+'/checkout-sessions/'+encodeURIComponent(order.payment_id.slice(3))+'/status/',{headers:spHeaders(),signal:AbortSignal.timeout(15000)});if(!r.ok)return 'pending';sd=spData(await r.json().catch(()=>({})))}catch{return 'pending'}
  const ss=String(sd.status||'').toUpperCase(),ts=String(sd.transaction_status||'').toUpperCase();
  if(ss==='PAID'&&ts==='SUCCESS'&&sd.transaction_id)order={...order,payment_id:String(sd.transaction_id)};
  else{if(/EXPIR|CANCEL|FAIL/.test(ss))failSaspayOrder(order.id);return one('select status from saspay_orders where id=?',order.id).status}
 }
 let d;
 try{const r=await fetch(SASPAY_BASE+'/payments/'+encodeURIComponent(order.payment_id)+'/verify/',{headers:spHeaders(),signal:AbortSignal.timeout(15000)});if(!r.ok)return 'pending';d=spData(await r.json().catch(()=>({})))}catch{return 'pending'}
 const st=String(d.status||'').toUpperCase();
 if(st==='SUCCESS'){
  const req=Math.round(Number(d.requested_amount||0)),net=Math.round(Number(d.net_amount||0)),cur=String(d.currency||'XOF');
  if(cur!=='XOF'||(req!==order.amount&&net!==order.amount)){console.warn('SasPay: montant non concordant',{order_id:order.id,expected:order.amount,requested:req,net});return 'pending'}
  creditSaspayOrder(order.id,source);
 }else if(/FAIL|CANCEL|EXPIR|REJECT|DECLIN|TIMEOUT/.test(st))failSaspayOrder(order.id);
 return one('select status from saspay_orders where id=?',order.id).status;
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
 if(!Number.isInteger(amount)||amount<DEPOSIT_MIN||amount>SASPAY_MAX)throw new E('Avec cette méthode, le dépôt doit être compris entre 1 000 et 10 000 FCFA.');
 if(network!=='auto'&&!SASPAY_NETWORKS[network])throw new E('Choisissez une méthode de dépôt.');
 const number=normTogoPhone(phoneRaw);if(!number)throw new E('Entrez un numéro togolais valide à 8 chiffres.');
 if(!SASPAY_API_KEY)throw new E('Le dépôt en ligne n’est pas encore configuré par l’administrateur.',503);
 const p=act(user(u.id));
 if(!p.nom||!p.prenom||!p.email)throw new E('Complétez d’abord vos informations dans Paramètres pour continuer.');
 if(one("select 1 from saspay_orders where user_id=? and status='pending' and created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')",p.id))throw new E('Un paiement est déjà en cours. Validez-le sur votre téléphone ou patientez 3 minutes.',429);
 const id=uid(),depositRef='saspay:'+id,base=reqBase(req);
 tx(()=>{run('insert into saspay_orders(id,user_id,amount,network,phone,deposit_ref) values(?,?,?,?,?,?)',id,p.id,amount,network,number,depositRef);
  run('insert into deposits(id,user_id,amount,ref,status) values(?,?,?,?,?)',uid(),p.id,amount,depositRef,'attente')});
 const payload={amount:amount.toFixed(2),currency:'XOF',country:'TG',network:'',description:'Dépôt Fruty',
  customer:{email:p.email,first_name:p.prenom,last_name:p.nom,phone:'+228'+number},metadata:{order_id:id,user_id:p.id}};
 if(base)payload.return_url=base+'/?payment=saspay#depot';
 try{
  if(network==='auto'){
   const cs=await createSaspayCheckout(p,amount,number,id,base);
   run('update saspay_orders set payment_id=? where id=?','cs:'+cs.id,id);
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
   run('update saspay_orders set payment_id=? where id=?','cs:'+cs.id,id);
   return {order_id:id,checkout_url:cs.url,message:'Redirection vers la page de paiement…'};
  }
  if(!r.ok||j.success===false||!d.id)throw new Error(lastMsg||JSON.stringify(j.error||j).slice(0,300)||'Erreur API SasPay');
  let checkout=null;if(d.checkout_url){try{const c=new URL(String(d.checkout_url));if(c.protocol==='https:'&&!c.username&&!c.password)checkout=c.toString()}catch{}}
  run('update saspay_orders set payment_id=? where id=?',String(d.id),id);
  return {order_id:id,checkout_url:checkout,message:d.instructions||d.message||'Validez le paiement sur votre téléphone.'};
 }catch(err){failSaspayOrder(id);console.error('SasPay softpay:',err.message);throw new E('Impossible de lancer le paiement. Vérifiez le numéro et le réseau, puis réessayez.',502)}
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
   const order=one('select * from saspay_orders where payment_id=?',String(d.id));
   if(order)await reconcileSaspayOrder(order,'webhook');
   else for(const o of all("select * from saspay_orders where status='pending' and payment_id like 'cs:%' and created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') limit 20"))await reconcileSaspayOrder(o,'webhook');
  }
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('OK');
 }catch(err){console.error('SasPay webhook error:',err);res.writeHead(500);res.end('Processing error')}
}

/* ---- API ---- */
const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const readBody=(req,max=3e6)=>new Promise((ok,ko)=>{let d='';req.on('data',c=>{d+=c;if(d.length>max){ko(new E('Fichier trop volumineux',413));req.destroy()}});req.on('end',()=>{try{ok(d?JSON.parse(d):{})}catch{ko(new E('Requête invalide'))}})});
async function api(req,res,url){
 const p=url.pathname,post=req.method==='POST',b=post?await readBody(req,p==='/api/admin/pdf'?15e6:3e6):{},ip=req.socket.remoteAddress,tok=verify((req.headers.authorization||'').slice(7));
 const U=()=>{if(!tok||tok.pre)throw new E('Non connecté',401);const u=user(tok.sub);if(!u)throw new E('Non connecté',401);return u};
 const A=()=>{const u=U();if(u.role!=='admin'||!tok.adm)throw new E('Accès refusé',403);return u};
 const out=d=>send(res,200,{data:d,error:null});
 if(p==='/api/register'&&post){limit('r'+ip,10);const ph=String(b.phone||'').replace(/\D/g,''),pw=String(b.password||'');
  if(ph.length<8||ph.length>15)throw new E('Entrez un numéro de 8 à 15 chiffres.');if(pw.length<6||pw.length>100)throw new E('Mot de passe : 6 caractères minimum.');
  if(one('select 1 from profiles where phone=?',ph))throw new E('Ce numéro a déjà un compte.');
  const inv=b.ref?one('select id from profiles where code=?',String(b.ref).toUpperCase()):null;if(b.ref&&!inv)throw new E("Ce code d'invitation n'existe pas.");
  let code;do{code='SP'+crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(one('select 1 from profiles where code=?',code));
  const id=uid();run('insert into profiles(id,phone,hash,code,inviter) values(?,?,?,?,?)',id,ph,hashPw(pw),code,inv&&inv.id);return out({id,token:sign({sub:id},2592000)})}
 if(p==='/api/login'&&post){const ph=String(b.phone||'').replace(/\D/g,'');limit('l'+ip+ph);const u=one('select * from profiles where phone=?',ph);
  if(!u||!checkPw(String(b.password||''),u.hash))throw new E('Téléphone ou mot de passe incorrect.',401);return out({id:u.id,token:sign({sub:u.id},2592000)})}
 if(p.startsWith('/api/t/')){const u=U(),t=p.slice(7);if(!T[t])throw new E('Inconnu',404);settlePurchaseRewards(u.id);const q=JSON.parse(url.searchParams.get('q')||'{}');let r=T[t](u);
  for(const [k,v] of Object.entries(q.eq||{}))r=r.filter(x=>String(x[k])===String(v));
  if(q.order){const [c,d]=q.order;r.sort((x,y)=>(x[c]>y[c]?1:x[c]<y[c]?-1:0)*(d==='desc'?-1:1))}if(q.limit)r=r.slice(0,Math.min(+q.limit,200));
  return out(q.one?(r[0]||null):r)}
 if(p==='/api/config'){return out({...PUBLIC_LINKS,support_email:'sikaplus.con0125@gmail.com'})}
 if(p==='/api/deposit/methods'){U();return out([1,2,3,4,5].map(n=>{const pv=DEPOSIT_METHODS[n];return {method:n,available:pv==='saspay'?!!SASPAY_API_KEY:pv==='chariow'?!!CHARIOW_API_KEY:false,kind:pv==='chariow'?'fixed':pv==='saspay'?'free':null,amounts:pv==='chariow'?CHARIOW_AMOUNTS:null,min:DEPOSIT_MIN,max:pv==='saspay'?SASPAY_MAX:null}}))}
 if(p==='/api/deposit'&&post){limit('dep'+ip,8,60000);const u=U(),amount=Math.floor(+b.amount),method=Math.floor(+b.method);
  if(!Number.isInteger(method)||method<1||method>5)throw new E('Choisissez une méthode de dépôt.');
  const provider=DEPOSIT_METHODS[method];
  if(provider==='saspay')return out(await createSaspayDeposit(u,req,amount,'auto',b.phone));
  if(provider==='chariow')return out(await createChariowDeposit(u,req,amount,method));
  throw new E('La méthode '+method+' sera bientôt disponible.',503)}
 if(p==='/api/saspay/deposit'&&post){limit('saspay'+ip,8,60000);const u=U();return out(await createSaspayDeposit(u,req,Math.floor(+b.amount),String(b.network||''),b.phone))}
 if(p==='/api/chariow/status'){const u=U();limit('chst'+u.id,60,60000);const o=one('select status from chariow_orders where id=? and user_id=?',String(url.searchParams.get('order')||''),u.id);if(!o)throw new E('Paiement introuvable',404);return out({status:o.status})}
 if(p==='/api/saspay/status'&&!url.searchParams.get('order')){const u=U();limit('spall'+u.id,30,60000);let credited=0,failed=0,pending=0,amount=0;for(const o of all("select * from saspay_orders where user_id=? and status='pending' and created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days') order by created_at desc limit 8",u.id)){const st=await reconcileSaspayOrder(o,'poll');if(st==='completed'){credited++;amount+=o.amount}else if(st==='failed')failed++;else pending++}return out({credited,failed,pending,amount})}
 if(p==='/api/saspay/status'){const u=U(),o=one('select * from saspay_orders where id=? and user_id=?',String(url.searchParams.get('order')||''),u.id);if(!o)throw new E('Paiement introuvable',404);limit('spst'+u.id,60,60000);return out({status:await reconcileSaspayOrder(o,'poll')||o.status})}
 if(p==='/api/checkout/deposit'&&post){limit('chariow'+ip,8,60000);const u=U(),amount=Math.floor(+b.amount),method=Math.floor(+b.method);return out(await createChariowDeposit(u,req,amount,method))}
 if(p.startsWith('/api/rpc/')&&post){const f=RPC[p.slice(9)];if(!f)throw new E('Inconnu',404);limit('x'+ip,120,60000);const u=U();settlePurchaseRewards(u.id);return out(f(u,b))}
 /* --- admin : mot de passe + code TOTP obligatoires --- */
 if(p==='/api/admin/login'&&post){limit('a'+ip,6);const u=one("select * from profiles where phone=? and role='admin'",String(b.phone||'').replace(/\D/g,''));
  if(!u||!checkPw(String(b.password||''),u.hash))throw new E('Identifiants incorrects.',401);
  if(!u.totp){const s=b32(crypto.randomBytes(20));run('update profiles set totp=?,totp_ok=0 where id=?',s,u.id);u.totp=s}
  return out({tmp:sign({sub:u.id,pre:1},300),enroll:!u.totp_ok,secret:u.totp_ok?null:u.totp,uri:u.totp_ok?null:`otpauth://totp/Fruty:${u.phone}?secret=${u.totp}&issuer=Fruty`})}
 if(p==='/api/admin/totp'&&post){limit('t'+ip,6);const t=verify(b.tmp||''),u=t&&t.pre&&user(t.sub);if(!u||u.role!=='admin')throw new E('Session expirée, reconnectez-vous.',401);
  if(!okTotp(u.totp,b.code))throw new E('Code incorrect.',401);run('update profiles set totp_ok=1 where id=?',u.id);return out({token:sign({sub:u.id,adm:1},28800)})}
 if(p.startsWith('/api/admin/')){const admin=A();const a=p.slice(11);
  if(a==='list'){const kind=url.searchParams.get('kind');if(kind==='questions'){const date=url.searchParams.get('date')||new Date().toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new E('Date invalide.');if(date===today())tx(()=>ensureDailyQuestions(date));return out(L.questions(date))}return out((L[kind]||(()=>{throw new E('Inconnu',404)}))())}
  if(a==='decide'&&post){const dep=b.kind==='deposit';if(dep){const pending=one("select * from deposits where id=? and status='attente'",b.id);if(pending&&(one('select 1 from chariow_orders where deposit_ref=?',pending.ref)||one('select 1 from saspay_orders where deposit_ref=?',pending.ref)))throw new E('Ce dépôt en ligne (Chariow/SasPay) est traité automatiquement après confirmation officielle du paiement. Aucune validation manuelle n’est autorisée.')}return out(tx(()=>{const x=one(`select * from ${dep?'deposits':'withdrawals'} where id=? and status='attente'`,b.id);if(!x)throw new E('Introuvable ou déjà traité');
   run(`update ${dep?'deposits':'withdrawals'} set status=? where id=?`,b.ok?'valide':'refuse',x.id);
   if(dep&&b.ok){run('update profiles set wallet_sub=wallet_sub+? where id=?',x.amount,x.user_id);led(x.user_id,'depot',x.amount)}
   if(!dep&&!b.ok)run('update profiles set wallet_gain=wallet_gain+? where id=?',x.amount,x.user_id);
   audit(admin,(dep?'deposit_':'withdrawal_')+(b.ok?'approved':'refused'),dep?'deposit':'withdrawal',x.id,{user_id:x.user_id,amount:x.amount},ip);return true}))}
  if(a==='user'&&post){return out(tx(()=>{const before=one('select wallet_sub,wallet_gain,vip,active from profiles where id=?',String(b.id||''));if(!before)throw new E('Client introuvable.',404);
   const sub=Math.max(0,Math.floor(+b.sub)||0),gain=Math.max(0,Math.floor(+b.gain)||0),vip=Math.min(3,Math.max(0,Math.floor(+b.vip)||0)),active=b.active?1:0;
   run('update profiles set wallet_sub=?,wallet_gain=?,vip=?,active=? where id=?',sub,gain,vip,active,b.id);
   if(sub!==before.wallet_sub)led(b.id,'ajustement_achat',sub-before.wallet_sub);
   if(gain!==before.wallet_gain)led(b.id,'ajustement_gain',gain-before.wallet_gain);
   audit(admin,'user_adjust','profile',b.id,{before,after:{wallet_sub:sub,wallet_gain:gain,vip,active}},ip);return true}))}
  if(a==='product'&&post){let id=b.id;if(!id){id=uid();run('insert into products(id,sym,name,hidden,pos) values(?,?,?,1,?)',id,'NEW','Nouveau produit',one('select count(*)+1 n from products').n)}
   const accessDays=b.access_days==null||b.access_days===''?0:Number(b.access_days),dailyReward=b.daily_reward==null||b.daily_reward===''?0:Number(b.daily_reward);
   if(!Number.isInteger(accessDays)||!Number.isInteger(dailyReward)||accessDays<0||accessDays>3650||dailyReward<0||dailyReward>1000000||(accessDays===0&&dailyReward>0))throw new E('Durée ou récompense invalide. Une récompense exige une durée d’accès positive.');
   const priceNow=pint(b.price);if(dailyReward>0&&(!priceNow||dailyReward*accessDays>priceNow*MAX_REWARD_RATIO))throw new E('Crédits trop élevés : le total des crédits ('+(dailyReward*accessDays)+' F) ne doit pas dépasser '+Math.round(MAX_REWARD_RATIO*100)+' % du prix du produit.');
   const oldPdf=one('select pdf_url from products where id=?',id),pdfUrl=String(b.pdf_url||'').trim().slice(0,500)||(oldPdf&&oldPdf.pdf_url)||'';
   run('update products set name=?,sym=?,color=?,price=?,teaser=?,hidden=?,facts=?,body=?,pdf_url=?,access_days=?,daily_reward=? where id=?',String(b.name||'').slice(0,60),String(b.sym||'').toUpperCase().slice(0,5),hex(b.color),pint(b.price),String(b.teaser||'').slice(0,300),b.hidden?1:0,String(b.facts||''),String(b.body||''),pdfUrl,accessDays,dailyReward,id);audit(admin,'product_save','product',id,{price:pint(b.price),access_days:accessDays,daily_reward:dailyReward,hidden:b.hidden?1:0},ip);return out(id)}
  if(a==='question'&&post)throw new E('Les questions sont maintenant tirées automatiquement de la banque de 50 questions.');
  if(a==='pdf'&&post){const m=/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl||'');if(!m||!one('select 1 from products where id=?',b.id))throw new E('Fichier PDF ou produit invalide.');const buf=Buffer.from(m[1],'base64');if(buf.length<8||buf.length>10*1024*1024||buf.subarray(0,5).toString()!=='%PDF-')throw new E('Le PDF doit être valide et faire 10 Mo maximum.');fs.writeFileSync(path.join(PDF,b.id+'.pdf'),buf,{mode:0o600});run('update products set pdf_url=? where id=?','/private-pdf/'+b.id,b.id);return out(true)}
  if(a==='image'&&post){const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl||'');if(!m||!one('select 1 from products where id=?',b.id))throw new E('Image invalide (PNG, JPG ou WebP).');
   const buf=Buffer.from(m[2],'base64');if(buf.length>2e6)throw new E('Image trop lourde (2 Mo max).');const f=`${b.id}-${Date.now()}.${m[1]==='jpeg'?'jpg':m[1]}`;fs.writeFileSync(path.join(UP,f),buf);run('update products set image_url=? where id=?','/uploads/'+f,b.id);return out('/uploads/'+f)}
  if(a==='options'&&post){const rows=(b.rows||[]).map(r=>({amount:Math.floor(+r.amount),label:String(r.label||'').slice(0,40),pay_url:/^https?:\/\//.test(r.pay_url||'')?String(r.pay_url).slice(0,500):''}));
   if(!rows.length||rows.some(r=>!(r.amount>=100))||new Set(rows.map(r=>r.amount)).size!==rows.length)throw new E('Montants invalides ou en double (minimum 100 FCFA).');
   tx(()=>{run('delete from deposit_options');rows.forEach(r=>run('insert into deposit_options values(?,?,?)',r.amount,r.label,r.pay_url))});return out(true)}
  if(a==='announce'&&post){if(b.del)run('delete from announcements where id=?',b.id);else{if(!String(b.title||'').trim())throw new E('Titre requis');run('insert into announcements(id,title,body) values(?,?,?)',uid(),String(b.title).slice(0,120),String(b.body||'').slice(0,1000))}return out(true)}}
 throw new E('Introuvable',404)}

/* ---- PDF privés : chaque ouverture revérifie le compte et l'accès en cours ---- */
function servePrivatePdf(req,res,url){
 if(req.method!=='GET'){res.writeHead(405,{'Allow':'GET','Cache-Control':'no-store'});return res.end('Méthode non autorisée');}
 const tok=verify((req.headers.authorization||'').slice(7));if(!tok||tok.pre){res.writeHead(401,{'Cache-Control':'no-store'});return res.end('Connexion requise');}
 const u=user(tok.sub);if(!u){res.writeHead(401,{'Cache-Control':'no-store'});return res.end('Connexion requise');}
 const productId=decodeURIComponent(url.pathname.slice('/private-pdf/'.length));
 if(!/^[a-zA-Z0-9-]{8,80}$/.test(productId)){res.writeHead(404);return res.end('PDF introuvable');}
 if(u.role!=='admin'){
  settlePurchaseRewards(u.id);
  const access=one("select 1 from product_accesses where user_id=? and product_id=? and (expires_at is null or expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",u.id,productId);
  if(!access){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end('Votre accès à ce PDF est expiré ou indisponible.');}
 }
 const product=one('select pdf_url from products where id=?',productId),file=path.join(PDF,productId+'.pdf');
 if(!product||product.pdf_url!=='/private-pdf/'+productId||!fs.existsSync(file)){res.writeHead(404,{'Cache-Control':'no-store'});return res.end('PDF introuvable');}
 res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Fruty-document.pdf"','Content-Length':fs.statSync(file).size,'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'});fs.createReadStream(file).pipe(res);
}

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
 try{if(url.pathname==='/webhooks/chariow'&&req.method==='POST')await chariowWebhook(req,res);else if(url.pathname==='/webhooks/saspay'&&req.method==='POST')await saspayWebhook(req,res);else if(url.pathname.startsWith('/api/'))await api(req,res,url);else if(url.pathname.startsWith('/private-pdf/'))servePrivatePdf(req,res,url);else serve(res,url)}
 catch(e){if(!(e instanceof E))console.error(e);send(res,e instanceof E?e.c:500,{data:null,error:{message:e instanceof E?e.message:'Erreur du serveur'}})}});

/* ---- premier démarrage : produits, montants, administrateur (via variables d'environnement) ---- */
seedQuestionBank();
if(!one('select 1 from products')){[['BTC','Bitcoin','#F7931A',4000,'La première cryptomonnaie, souvent comparée à de l\'or numérique.'],['ETH','Ethereum','#627EEA',10000,'La plateforme des contrats intelligents.'],['USDT','Tether','#26A17B',18000,'Un stablecoin conçu pour valoir 1 dollar.'],['BNB','BNB','#F3BA2F',null,'Le jeton de l\'écosystème Binance.'],['XRP','XRP','#3B4A63',null,'Pensée pour les paiements internationaux.'],['SOL','Solana','#9945FF',null,'Une blockchain rapide aux frais très bas.'],['USDC','USD Coin','#2775CA',null,'Un stablecoin en dollars émis par Circle.'],['TRX','TRON','#EB0029',null,'Très utilisée pour envoyer de l\'USDT.'],['DOGE','Dogecoin','#C2A633',null,'Née d\'une blague, devenue très connue.'],['ADA','Cardano','#2A5ADA',null,'Une blockchain bâtie sur la recherche.']].forEach((r,i)=>run('insert into products(id,sym,name,color,price,teaser,pos) values(?,?,?,?,?,?,?)',uid(),r[0],r[1],r[2],r[3],r[4],i+1))}
const AP=String(process.env.ADMIN_PHONE||'').replace(/\D/g,''),AW=process.env.ADMIN_PASSWORD||'';
if(AP&&AW.length>=10&&!one('select 1 from profiles where phone=?',AP)){let ac='SPADMIN';while(one('select 1 from profiles where code=?',ac))ac='SP'+crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();run("insert into profiles(id,phone,hash,role,code,active) values(?,?,?,'admin',?,1)",uid(),AP,hashPw(AW),ac)}
if(!one("select 1 from profiles where role='admin'"))console.log("⚠ Aucun administrateur. Relancez avec ADMIN_PHONE=... ADMIN_PASSWORD=... (10 caractères minimum).");
if(require.main===module){server.listen(PORT,()=>console.log(`Fruty prêt : http://localhost:${PORT}  (admin : /gestion)`));try{settleAllPurchaseRewards()}catch(e){console.error('Erreur de traitement des crédits PDF :',e)}const rewardTimer=setInterval(()=>{try{settleAllPurchaseRewards()}catch(e){console.error('Erreur de traitement des crédits PDF :',e)}},60_000);rewardTimer.unref();}
module.exports={server,totp,b32};
