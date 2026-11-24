'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {query,closePool}=require('./backend/database/pool');
const auth=require('./backend/auth/service');
const wallet=require('./backend/wallet/service');
const PORT=Number(process.env.PORT)||3000,PUBLIC_DIR=path.join(__dirname,'public');
const COOKIE='fructy_session',MAX_BODY=32*1024;
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function sendJson(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body))}
function cookieOptions(maxAge){return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`}
function readCookie(header,name){for(const part of String(header||'').split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim())}return null}
function setSessionCookie(res,token,expiresAt){const maxAge=Math.max(0,Math.floor((new Date(expiresAt).getTime()-Date.now())/1000));res.setHeader('set-cookie',`${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`)}
async function readRawBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});chunks.push(chunk)}return Buffer.concat(chunks)}
async function readJson(req){let size=0,body='';for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error('Requête trop volumineuse.'),{status:413});body+=chunk.toString('utf8')}if(!body)return {};try{const value=JSON.parse(body);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value}catch{throw Object.assign(new Error('Corps JSON invalide.'),{status:400})}}
function clientIp(req){return String(req.socket.remoteAddress||'').slice(0,80)}
const server=http.createServer(async(req,res)=>{
 const requestId=randomUUID();res.setHeader('x-request-id',requestId);res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','strict-origin-when-cross-origin');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 let pathname;try{pathname=new URL(req.url,'http://localhost').pathname}catch{return sendJson(res,400,{error:{message:'URL invalide.'},requestId})}
 try{
  if(pathname==='/health'||pathname==='/healthz'){try{await query('SELECT 1');return sendJson(res,200,{status:'ok',service:'fructy-v12',database:'connected'})}catch{return sendJson(res,503,{status:'degraded',service:'fructy-v12',database:'unavailable'})}}
  if(pathname==='/api/register'&&req.method==='POST'){
   const body=await readJson(req);await auth.register(body);
   const session=await auth.login({phone:body.phone,password:body.password},clientIp(req));
   setSessionCookie(res,session.token,session.expiresAt);
   return sendJson(res,201,{ok:true,user:session.user});
  }
  if(pathname==='/api/login'&&req.method==='POST'){
   const body=await readJson(req),session=await auth.login(body,clientIp(req));
   setSessionCookie(res,session.token,session.expiresAt);
   return sendJson(res,200,{ok:true,user:session.user});
  }
  if(pathname==='/api/logout'&&req.method==='POST'){
   const token=readCookie(req.headers.cookie,COOKIE);await auth.logout(token);
   res.setHeader('set-cookie',cookieOptions(0));return sendJson(res,200,{ok:true});
  }
  if(pathname==='/api/me'&&req.method==='GET'){
   const token=readCookie(req.headers.cookie,COOKIE),user=await auth.authenticate(token);
   if(!user)return sendJson(res,401,{error:{code:'UNAUTHENTICATED',message:'Session absente ou expirée.'},requestId});
   return sendJson(res,200,{ok:true,user});
  }
  if(pathname==='/api/wallets'&&req.method==='GET'){
   const token=readCookie(req.headers.cookie,COOKIE),user=await auth.authenticate(token);
   if(!user)return sendJson(res,401,{error:{code:'UNAUTHENTICATED',message:'Session absente ou expirée.'},requestId});
   return sendJson(res,200,{ok:true,wallets:await wallet.getWallets(user.id)});
  }
  if(pathname==='/api/wallets/transactions'&&req.method==='GET'){
   const token=readCookie(req.headers.cookie,COOKIE),user=await auth.authenticate(token);
   if(!user)return sendJson(res,401,{error:{code:'UNAUTHENTICATED',message:'Session absente ou expirée.'},requestId});
   const url=new URL(req.url,'http://localhost');
   const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):25;
   return sendJson(res,200,{ok:true,transactions:await wallet.getTransactions(user.id,{limit,before:url.searchParams.get('before')})});
  }
  if(pathname==='/api/deposits'&&req.method==='POST'){
   const token=readCookie(req.headers.cookie,COOKIE),user=await auth.authenticate(token);
   if(!user)return sendJson(res,401,{error:{code:'UNAUTHENTICATED',message:'Session absente ou expirée.'},requestId});
   const body=await readJson(req);
   const result=await wallet.createDepositIntent(user.id,{...body,idempotencyKey:req.headers['idempotency-key']});
   return sendJson(res,result.replayed?200:201,{ok:true,deposit:result});
  }
  if(pathname==='/api/withdrawals'&&req.method==='POST'){
   const token=readCookie(req.headers.cookie,COOKIE),user=await auth.authenticate(token);
   if(!user)return sendJson(res,401,{error:{code:'UNAUTHENTICATED',message:'Session absente ou expirée.'},requestId});
   const body=await readJson(req);
   const result=await wallet.requestWithdrawal(user.id,{...body,idempotencyKey:req.headers['idempotency-key']});
   return sendJson(res,result.replayed?200:201,{ok:true,withdrawal:result});
  }
  if(pathname==='/api/webhooks/saspay'&&req.method==='POST'){
   const raw=await readRawBody(req);
   const result=await wallet.processDepositWebhook('saspay',raw,req.headers['x-fructy-signature']);
   return sendJson(res,200,{ok:true,...result});
  }
  if(pathname==='/api/webhooks/chariow'&&req.method==='POST'){
   const raw=await readRawBody(req);
   const result=await wallet.processDepositWebhook('chariow',raw,req.headers['x-fructy-signature']);
   return sendJson(res,200,{ok:true,...result});
  }
  if(pathname.startsWith('/api/'))return sendJson(res,404,{error:{code:'NOT_FOUND',message:'Route API introuvable.'},requestId});
  if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(res,405,{error:{message:'Méthode non autorisée.'},requestId});
  const requested=pathname==='/'?'client.html':pathname.replace(/^\/+/,''),resolved=path.resolve(PUBLIC_DIR,requested);
  if(!resolved.startsWith(PUBLIC_DIR+path.sep)&&resolved!==PUBLIC_DIR)return sendJson(res,403,{error:{message:'Accès refusé.'},requestId});
  let stat;try{stat=await fs.promises.stat(resolved)}catch{return sendJson(res,404,{error:{message:'Page introuvable.'},requestId})}
  if(!stat.isFile())return sendJson(res,404,{error:{message:'Fichier introuvable.'},requestId});
  res.writeHead(200,{'content-type':MIME[path.extname(resolved).toLowerCase()]||'application/octet-stream','content-length':stat.size,'cache-control':path.extname(resolved)==='.html'?'no-store':'public, max-age=300'});
  if(req.method==='HEAD')return res.end();fs.createReadStream(resolved).pipe(res);
 }catch(error){
  const status=Number.isInteger(error.status)?error.status:(error.code==='23505'?409:400);
  const message=error.code==='23505'?'Ce numéro est déjà associé à un compte.':error.message||'Une erreur est survenue.';
  if(status>=500)console.error('[http]',requestId,error.message);
  return sendJson(res,status,{error:{code:error.code==='23505'?'ALREADY_EXISTS':'REQUEST_FAILED',message},requestId});
 }
});
server.listen(PORT,()=>console.log(`Fructy V12 écoute sur le port ${PORT}.`));
async function shutdown(signal){console.log(`Arrêt demandé: ${signal}`);server.close(async()=>{try{await closePool();process.exit(0)}catch{process.exit(1)}});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
