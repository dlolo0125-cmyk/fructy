'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {query,closePool}=require('./backend/database/pool');
const PORT=Number(process.env.PORT)||3000,PUBLIC_DIR=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function sendJson(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body))}
const server=http.createServer(async(req,res)=>{
 const requestId=randomUUID();res.setHeader('x-request-id',requestId);res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','strict-origin-when-cross-origin');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 let pathname;try{pathname=new URL(req.url,'http://localhost').pathname}catch{return sendJson(res,400,{error:{message:'URL invalide.'},requestId})}
 if(pathname==='/health'||pathname==='/healthz'){try{await query('SELECT 1');return sendJson(res,200,{status:'ok',service:'fructy-v12',database:'connected'})}catch{return sendJson(res,503,{status:'degraded',service:'fructy-v12',database:'unavailable'})}}
 if(pathname.startsWith('/api/'))return sendJson(res,503,{error:{code:'V12_API_IN_PROGRESS',message:'Les services Fructy V12 sont en cours de reconstruction.'},requestId});
 if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(res,405,{error:{message:'Méthode non autorisée.'},requestId});
 const requested=pathname==='/'?'client.html':pathname.replace(/^\/+/,''),resolved=path.resolve(PUBLIC_DIR,requested);
 if(!resolved.startsWith(PUBLIC_DIR+path.sep)&&resolved!==PUBLIC_DIR)return sendJson(res,403,{error:{message:'Accès refusé.'},requestId});
 let stat;try{stat=await fs.promises.stat(resolved)}catch{return sendJson(res,404,{error:{message:'Page introuvable.'},requestId})}
 if(!stat.isFile())return sendJson(res,404,{error:{message:'Fichier introuvable.'},requestId});
 res.writeHead(200,{'content-type':MIME[path.extname(resolved).toLowerCase()]||'application/octet-stream','content-length':stat.size,'cache-control':path.extname(resolved)==='.html'?'no-store':'public, max-age=300'});
 if(req.method==='HEAD')return res.end();fs.createReadStream(resolved).pipe(res)
});
server.listen(PORT,()=>console.log(`Fructy V12 écoute sur le port ${PORT}.`));
async function shutdown(signal){console.log(`Arrêt demandé: ${signal}`);server.close(async()=>{try{await closePool();process.exit(0)}catch{process.exit(1)}});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
