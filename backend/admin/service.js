'use strict';

const { query, transaction } = require('../database/pool');
const { pageOptions } = require('../wallet/service');

function textField(value, label, max = 240, required = true) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new TypeError(label + ' obligatoire.');
  if (result.length > max) throw new TypeError(label + ' trop long.');
  return result;
}
function amountField(value, label, allowZero = true) {
  const raw = String(value ?? '');
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(label + ' doit être un entier positif.');
  const amount = BigInt(raw);
  if ((!allowZero && amount === 0n) || amount > 9000000000000000n) throw new TypeError(label + ' hors limites.');
  return amount.toString();
}
function intField(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new TypeError(label + ' invalide.');
  return number;
}
function slugify(value) {
  return textField(value,'Titre',180).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,180);
}
async function audit(tx, adminId, action, targetType, targetId, details = {}) {
  await tx.query(
    'INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [adminId,action,targetType,String(targetId),JSON.stringify(details)]
  );
}

async function getOverview() {
  const result = await query(`
    SELECT (SELECT count(*)::text FROM users) AS users_total,
      (SELECT count(*)::text FROM users WHERE status='active') AS users_active,
      (SELECT count(*)::text FROM users WHERE status='pending') AS users_pending,
      (SELECT count(*)::text FROM withdrawals WHERE status='pending') AS withdrawals_pending,
      (SELECT COALESCE(sum(balance),0)::text FROM wallets WHERE wallet_type='deposit') AS deposits_balance,
      (SELECT COALESCE(sum(balance),0)::text FROM wallets WHERE wallet_type='earnings') AS earnings_balance
  `);
  return result.rows[0];
}
async function listUsers(options = {}) {
  const { limit, before } = pageOptions(options);
  const search = String(options.search ?? '').trim().slice(0, 80);
  const result = await query(
    `SELECT id,phone,role,status,first_name,last_name,email,created_at FROM users
     WHERE ($1='' OR phone ILIKE '%' || $1 || '%' OR COALESCE(first_name,'') ILIKE '%' || $1 || '%' OR COALESCE(last_name,'') ILIKE '%' || $1 || '%')
       AND ($2::timestamptz IS NULL OR created_at<$2)
     ORDER BY created_at DESC,id DESC LIMIT $3`, [search,before,limit]
  );
  return result.rows;
}

async function listAdminCatalog() {
  const [products,courses,categories,questions,modules,lessons] = await Promise.all([
    query('SELECT id,name,description,price::text,currency,access_days,daily_reward::text,published,file_key,created_at FROM products ORDER BY created_at DESC LIMIT 100'),
    query(`SELECT c.id,c.title,c.slug,c.description,c.price::text,c.currency,c.status,c.category_id,
      (SELECT count(*)::int FROM course_modules m WHERE m.course_id=c.id) AS module_count
      FROM courses c ORDER BY c.created_at DESC LIMIT 100`),
    query('SELECT id,name,slug,sort_order,active FROM course_categories ORDER BY sort_order,name'),
    query('SELECT id,question_date,prompt,options,reward_amount::text,active FROM daily_questions ORDER BY question_date DESC,id DESC LIMIT 60'),
    query('SELECT id,course_id,title,sort_order FROM course_modules ORDER BY course_id,sort_order'),
    query('SELECT id,module_id,title,content_type,published FROM lessons ORDER BY module_id,sort_order')
  ]);
  return { products:products.rows, courses:courses.rows, categories:categories.rows, questions:questions.rows, modules:modules.rows, lessons:lessons.rows };
}

async function createProduct(adminId, input) {
  const name=textField(input.name,'Nom du produit'), description=textField(input.description,'Description',5000,false);
  const price=amountField(input.price,'Prix'), reward=amountField(input.dailyReward ?? 0,'Récompense');
  const accessDays=intField(input.accessDays ?? 0,'Durée',0,3650);
  if(accessDays===0 && reward!=='0') throw new TypeError('Une récompense exige une durée d’accès.');
  const fileKey=textField(input.fileKey,'Clé du fichier',500,false);
  const published=input.published===true;
  return transaction(async tx=>{
    const r=await tx.query(`INSERT INTO products(name,description,price,currency,file_key,access_days,daily_reward,published)
      VALUES($1,$2,$3,'XOF',$4,$5,$6,$7) RETURNING id,name,price::text,published`,
      [name,description,price,fileKey||null,accessDays,reward,published]);
    await audit(tx,adminId,'product.create','product',r.rows[0].id,{name,price,published});
    return r.rows[0];
  });
}
async function updateProduct(adminId,id,input) {
  const name=textField(input.name,'Nom du produit'),description=textField(input.description,'Description',5000,false);
  const price=amountField(input.price,'Prix'),reward=amountField(input.dailyReward ?? 0,'Récompense');
  const accessDays=intField(input.accessDays ?? 0,'Durée',0,3650);
  if(accessDays===0&&reward!=='0') throw new TypeError('Une récompense exige une durée d’accès.');
  const fileKey=textField(input.fileKey,'Clé du fichier',500,false),published=input.published===true;
  return transaction(async tx=>{
    const r=await tx.query(`UPDATE products SET name=$2,description=$3,price=$4,file_key=$5,access_days=$6,daily_reward=$7,published=$8
      WHERE id=$1 RETURNING id,name,price::text,published`,[id,name,description,price,fileKey||null,accessDays,reward,published]);
    if(!r.rowCount){const e=new Error('Produit introuvable.');e.status=404;throw e;}
    await audit(tx,adminId,'product.update','product',id,{name,price,published});
    return r.rows[0];
  });
}
async function createCategory(adminId,input) {
  const name=textField(input.name,'Nom de catégorie',120),slug=slugify(input.slug||name);
  const order=intField(input.sortOrder??0,'Ordre',-10000,10000);
  return transaction(async tx=>{
    const r=await tx.query('INSERT INTO course_categories(name,slug,sort_order) VALUES($1,$2,$3) RETURNING *',[name,slug,order]);
    await audit(tx,adminId,'course_category.create','course_category',r.rows[0].id,{name,slug});
    return r.rows[0];
  });
}
async function createCourse(adminId,input) {
  const title=textField(input.title,'Titre de formation',180),slug=slugify(input.slug||title);
  const description=textField(input.description,'Description',10000,false),price=amountField(input.price??0,'Prix');
  const categoryId=input.categoryId||null,status=input.published===true?'published':'draft';
  return transaction(async tx=>{
    const r=await tx.query(`INSERT INTO courses(category_id,title,slug,description,price,currency,status)
      VALUES($1,$2,$3,$4,$5,'XOF',$6) RETURNING id,title,slug,status`,
      [categoryId,title,slug,description,price,status]);
    await audit(tx,adminId,'course.create','course',r.rows[0].id,{title,slug,status});
    return r.rows[0];
  });
}
async function setCourseStatus(adminId,id,status) {
  if(!['draft','published','archived'].includes(status)) throw new TypeError('Statut de formation invalide.');
  return transaction(async tx=>{
    const r=await tx.query('UPDATE courses SET status=$2 WHERE id=$1 RETURNING id,title,status',[id,status]);
    if(!r.rowCount){const e=new Error('Formation introuvable.');e.status=404;throw e;}
    await audit(tx,adminId,'course.status','course',id,{status});
    return r.rows[0];
  });
}
async function createModule(adminId,courseId,input) {
  const title=textField(input.title,'Titre du module',180),order=intField(input.sortOrder??0,'Ordre',-10000,10000);
  return transaction(async tx=>{
    const exists=await tx.query('SELECT id FROM courses WHERE id=$1',[courseId]);
    if(!exists.rowCount){const e=new Error('Formation introuvable.');e.status=404;throw e;}
    const r=await tx.query('INSERT INTO course_modules(course_id,title,sort_order) VALUES($1,$2,$3) RETURNING *',[courseId,title,order]);
    await audit(tx,adminId,'course_module.create','course_module',r.rows[0].id,{courseId,title});
    return r.rows[0];
  });
}
async function createLesson(adminId,moduleId,input) {
  const title=textField(input.title,'Titre de la leçon',180),type=textField(input.contentType,'Type',20);
  if(!['video','pdf','text','external'].includes(type)) throw new TypeError('Type de contenu invalide.');
  const content=textField(input.content,'Contenu',20000,false),order=intField(input.sortOrder??0,'Ordre',-10000,10000);
  return transaction(async tx=>{
    const exists=await tx.query('SELECT id FROM course_modules WHERE id=$1',[moduleId]);
    if(!exists.rowCount){const e=new Error('Module introuvable.');e.status=404;throw e;}
    const r=await tx.query(`INSERT INTO lessons(module_id,title,content_type,content,sort_order,published)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,content_type,published`,
      [moduleId,title,type,content,order,input.published===true]);
    await audit(tx,adminId,'lesson.create','lesson',r.rows[0].id,{moduleId,title,type});
    return r.rows[0];
  });
}
async function setLessonPublished(adminId,id,published) {
  return transaction(async tx=>{
    const r=await tx.query('UPDATE lessons SET published=$2 WHERE id=$1 RETURNING id,title,published',[id,published===true]);
    if(!r.rowCount){const e=new Error('Leçon introuvable.');e.status=404;throw e;}
    await audit(tx,adminId,'lesson.publish','lesson',id,{published:published===true});
    return r.rows[0];
  });
}
async function createDailyQuestion(adminId,input) {
  const date=textField(input.date,'Date',10),prompt=textField(input.prompt,'Question',1000);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('Date invalide (AAAA-MM-JJ).');
  if(!Array.isArray(input.options)||input.options.length<2||input.options.length>4) throw new TypeError('La question doit avoir 2 à 4 choix.');
  const options=input.options.map((v,i)=>textField(v,'Choix '+(i+1),300));
  const correct=intField(input.correctOption,'Bonne réponse',0,options.length-1);
  const reward=amountField(input.rewardAmount??0,'Récompense');
  const explanation=textField(input.explanation,'Explication',2000,false);
  return transaction(async tx=>{
    const r=await tx.query(`INSERT INTO daily_questions(question_date,prompt,options,correct_option,reward_amount,explanation,active)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING id,question_date,prompt,options,reward_amount::text,active`,
      [date,prompt,JSON.stringify(options),correct,reward,explanation,input.active!==false]);
    await audit(tx,adminId,'daily_question.create','daily_question',r.rows[0].id,{date,prompt,reward});
    return r.rows[0];
  });
}
async function setQuestionActive(adminId,id,active) {
  return transaction(async tx=>{
    const r=await tx.query('UPDATE daily_questions SET active=$2 WHERE id=$1 RETURNING id,question_date,prompt,active',[id,active===true]);
    if(!r.rowCount){const e=new Error('Question introuvable.');e.status=404;throw e;}
    await audit(tx,adminId,'daily_question.active','daily_question',id,{active:active===true});
    return r.rows[0];
  });
}


async function setUserStatus(adminId,userId,status) {
  if(!['active','pending','suspended','closed'].includes(status)) throw new TypeError('Statut de compte invalide.');
  return transaction(async tx=>{
    const target=await tx.query('SELECT id,role,status FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(!target.rowCount){const e=new Error('Membre introuvable.');e.status=404;throw e;}
    if(target.rows[0].role==='admin') {const e=new Error('La modification des comptes administrateurs est interdite depuis cette console.');e.status=403;throw e;}
    const updated=await tx.query('UPDATE users SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,phone,status',[userId,status]);
    await audit(tx,adminId,'user.status','user',userId,{from:target.rows[0].status,to:status});
    return updated.rows[0];
  });
}
async function sendNotification(adminId,input) {
  const title=textField(input.title,'Titre de notification',180);
  const body=textField(input.body,'Message',4000,false);
  const userId=input.userId?textField(input.userId,'Identifiant membre',36):null;
  return transaction(async tx=>{
    let result;
    if(userId){
      const exists=await tx.query(`SELECT id FROM users WHERE id=$1 AND status<>'closed'`,[userId]);
      if(!exists.rowCount){const e=new Error('Membre introuvable ou fermé.');e.status=404;throw e;}
      result=await tx.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3) RETURNING id,user_id,title,body,created_at',[userId,title,body]);
    }else{
      result=await tx.query(`INSERT INTO notifications(user_id,title,body)
        SELECT id,$1,$2 FROM users WHERE status='active'
        RETURNING id,user_id,title,body,created_at`,[title,body]);
    }
    await audit(tx,adminId,'notification.send',userId?'user':'broadcast',userId||'active-users',{title,count:result.rowCount});
    return {count:result.rowCount};
  });
}

module.exports={getOverview,listUsers,listAdminCatalog,createProduct,updateProduct,createCategory,createCourse,setCourseStatus,createModule,createLesson,setLessonPublished,createDailyQuestion,setQuestionActive,setUserStatus,sendNotification,amountField,intField,slugify};
