'use strict';

const { query, transaction } = require('../database/pool');

async function listProducts() {
  const result = await query(
    `SELECT id,name,description,price,currency,access_days,daily_reward,created_at
     FROM products WHERE published=true ORDER BY created_at DESC,id DESC`
  );
  return result.rows.map(row => ({ ...row, price: String(row.price), daily_reward: String(row.daily_reward) }));
}


async function listMyProductAccesses(userId) {
  const result = await query(
    `SELECT a.id,a.product_id,p.name,p.daily_reward,p.access_days,a.purchased_at,a.expires_at,
            (SELECT count(*)::int FROM product_reward_credits r WHERE r.product_access_id=a.id) AS rewards_claimed
     FROM product_accesses a JOIN products p ON p.id=a.product_id
     WHERE a.user_id=$1 AND (a.expires_at IS NULL OR a.expires_at>now())
     ORDER BY a.purchased_at DESC`,
    [userId]
  );
  return result.rows.map(row => ({ ...row, daily_reward: String(row.daily_reward) }));
}

async function purchaseProduct(userId, productId) {
  return transaction(async tx => {
    const productResult = await tx.query(
      `SELECT id,name,price,currency,access_days,daily_reward,file_key
       FROM products WHERE id=$1 AND published=true FOR SHARE`,
      [productId]
    );
    if (!productResult.rowCount) {
      const error = new Error('Produit introuvable ou indisponible.');
      error.status = 404;
      throw error;
    }
    const product = productResult.rows[0];
    if (!product.file_key) {
      const error = new Error('Ce produit ne possède pas encore de fichier disponible.');
      error.status = 409;
      throw error;
    }
    const walletResult = await tx.query(
      `SELECT id,balance FROM wallets
       WHERE user_id=$1 AND wallet_type='deposit' AND currency=$2 FOR UPDATE`,
      [userId, product.currency]
    );
    if (!walletResult.rowCount) {
      const error = new Error('Portefeuille de dépôt introuvable.');
      error.status = 404;
      throw error;
    }
    const active = await tx.query(
      `SELECT id,expires_at FROM product_accesses
       WHERE user_id=$1 AND product_id=$2
         AND (expires_at IS NULL OR expires_at>now())
       ORDER BY purchased_at DESC LIMIT 1`,
      [userId, product.id]
    );
    if (active.rowCount) {
      return { access: active.rows[0], alreadyOwned: true };
    }
    if (BigInt(walletResult.rows[0].balance) < BigInt(product.price)) {
      const error = new Error('Solde du portefeuille dépôt insuffisant.');
      error.status = 409;
      throw error;
    }
    const access = await tx.query(
      `INSERT INTO product_accesses(user_id,product_id,price_paid,purchased_at,expires_at)
       VALUES($1,$2,$3,now(),CASE WHEN $4::integer=0 THEN NULL ELSE now()+($4::text || ' days')::interval END)
       RETURNING id,product_id,price_paid,purchased_at,expires_at`,
      [userId, product.id, product.price, product.access_days]
    );
    if (BigInt(product.price) > 0n) {
      await tx.query('UPDATE wallets SET balance=balance-$1,updated_at=now() WHERE id=$2', [product.price, walletResult.rows[0].id]);
      await tx.query(
        `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
         VALUES($1,$2,'product_purchase',$3,$4,'product_access',$5,$6,$7)`,
        [walletResult.rows[0].id,userId,-BigInt(product.price).toString(),product.currency,access.rows[0].id,
         `product-purchase:${access.rows[0].id}`,`Achat : ${product.name}`]
      );
    }
    return { access: access.rows[0], alreadyOwned: false };
  });
}

async function createProductDownloadUrl(userId, productId) {
  const result = await query(
    `SELECT p.id,p.name,p.file_key
     FROM product_accesses a JOIN products p ON p.id=a.product_id
     WHERE a.user_id=$1 AND p.id=$2 AND p.published=true
       AND (a.expires_at IS NULL OR a.expires_at>now())
     ORDER BY a.purchased_at DESC LIMIT 1`,
    [userId, productId]
  );
  if (!result.rowCount) {
    const error = new Error('Achat requis ou accès expiré.');
    error.status = 403;
    throw error;
  }
  const product = result.rows[0];
  if (!product.file_key) {
    const error = new Error('Fichier du produit indisponible.');
    error.status = 404;
    throw error;
  }
  const { createDownloadUrl } = require('../storage/r2');
  return { url: await createDownloadUrl(product.file_key, product.name), expiresIn: 60 };
}

async function listCourses() {
  const result = await query(
    `SELECT c.id,c.title,c.slug,c.description,c.price,c.currency,c.created_at,
            cc.name AS category_name,cc.slug AS category_slug,
            (SELECT count(*)::int FROM course_modules m WHERE m.course_id=c.id) AS module_count,
            (SELECT count(*)::int FROM lessons l JOIN course_modules m ON m.id=l.module_id
             WHERE m.course_id=c.id AND l.published=true) AS lesson_count
     FROM courses c LEFT JOIN course_categories cc ON cc.id=c.category_id
     WHERE c.status='published' ORDER BY c.created_at DESC,c.id DESC`
  );
  return result.rows.map(row => ({ ...row, price: String(row.price) }));
}

async function getCourse(userId, courseId) {
  const course = await query(
    `SELECT c.id,c.title,c.slug,c.description,c.price,c.currency,cc.name AS category_name,
            EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id=c.id AND e.user_id=$1 AND e.status='active') AS enrolled
     FROM courses c LEFT JOIN course_categories cc ON cc.id=c.category_id
     WHERE c.id=$2 AND c.status='published'`,
    [userId, courseId]
  );
  if (!course.rowCount) {
    const error = new Error('Formation introuvable.');
    error.status = 404;
    throw error;
  }
  const row = course.rows[0];
  if (!row.enrolled) return { ...row, price: String(row.price), modules: [] };
  const modules = await query(
    `SELECT m.id,m.title,m.sort_order,
       COALESCE(json_agg(json_build_object(
         'id',l.id,'title',l.title,'content_type',l.content_type,'content',l.content,
         'sort_order',l.sort_order,'progress_percent',COALESCE(lp.progress_percent,0),
         'completed_at',lp.completed_at
       ) ORDER BY l.sort_order) FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS lessons
     FROM course_modules m
     LEFT JOIN lessons l ON l.module_id=m.id AND l.published=true
     LEFT JOIN lesson_progress lp ON lp.lesson_id=l.id AND lp.user_id=$1
     WHERE m.course_id=$2 GROUP BY m.id ORDER BY m.sort_order`,
    [userId, courseId]
  );
  return { ...row, price: String(row.price), modules: modules.rows };
}

async function enrollCourse(userId, courseId) {
  return transaction(async tx => {
    const courseResult = await tx.query(
      `SELECT id,title,price,currency FROM courses
       WHERE id=$1 AND status='published' FOR SHARE`,
      [courseId]
    );
    if (!courseResult.rowCount) {
      const error = new Error('Formation introuvable ou indisponible.');
      error.status = 404;
      throw error;
    }
    const course = courseResult.rows[0];
    const existing = await tx.query(
      `SELECT id,status,enrolled_at FROM enrollments
       WHERE user_id=$1 AND course_id=$2 FOR UPDATE`,
      [userId, courseId]
    );
    if (existing.rowCount && existing.rows[0].status === 'active') return { enrollment: existing.rows[0], alreadyEnrolled: true };
    if (existing.rowCount) {
      const error = new Error('Cette inscription a été révoquée. Contacte le support pour rétablir ton accès.');
      error.status = 409;
      throw error;
    }
    let walletId = null;
    if (BigInt(course.price) > 0n) {
      const wallet = await tx.query(
        `SELECT id,balance FROM wallets WHERE user_id=$1 AND wallet_type='deposit' AND currency=$2 FOR UPDATE`,
        [userId, course.currency]
      );
      if (!wallet.rowCount || BigInt(wallet.rows[0].balance) < BigInt(course.price)) {
        const error = new Error('Solde du portefeuille dépôt insuffisant.');
        error.status = 409;
        throw error;
      }
      walletId = wallet.rows[0].id;
      await tx.query('UPDATE wallets SET balance=balance-$1,updated_at=now() WHERE id=$2', [course.price, walletId]);
    }
    let enrollment;
    if (existing.rowCount) {
      enrollment = await tx.query(
        `UPDATE enrollments SET status='active',enrolled_at=now()
         WHERE id=$1 RETURNING id,status,enrolled_at`,
        [existing.rows[0].id]
      );
    } else {
      enrollment = await tx.query(
        `INSERT INTO enrollments(user_id,course_id,status)
         VALUES($1,$2,'active') RETURNING id,status,enrolled_at`,
        [userId,courseId]
      );
    }
    if (walletId) {
      await tx.query(
        `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
         VALUES($1,$2,'course_purchase',$3,$4,'enrollment',$5,$6,$7)`,
        [walletId,userId,-BigInt(course.price).toString(),course.currency,enrollment.rows[0].id,
         `course-purchase:${enrollment.rows[0].id}`,`Inscription : ${course.title}`]
      );
    }
    return { enrollment: enrollment.rows[0], alreadyEnrolled: false };
  });
}

async function updateLessonProgress(userId, lessonId, progressPercent) {
  const percent = Number(progressPercent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new TypeError('Progression invalide.');
  const result = await query(
    `INSERT INTO lesson_progress(user_id,lesson_id,progress_percent,completed_at,updated_at)
     SELECT $1,l.id,$3,CASE WHEN $3=100 THEN now() ELSE NULL END,now()
     FROM lessons l JOIN course_modules m ON m.id=l.module_id
     JOIN enrollments e ON e.course_id=m.course_id AND e.user_id=$1 AND e.status='active'
     WHERE l.id=$2 AND l.published=true
     ON CONFLICT(user_id,lesson_id) DO UPDATE SET
       progress_percent=GREATEST(lesson_progress.progress_percent,EXCLUDED.progress_percent),
       completed_at=CASE WHEN GREATEST(lesson_progress.progress_percent,EXCLUDED.progress_percent)=100
         THEN COALESCE(lesson_progress.completed_at,now()) ELSE lesson_progress.completed_at END,
       updated_at=now()
     RETURNING user_id,lesson_id,progress_percent,completed_at,updated_at`,
    [userId, lessonId, percent]
  );
  if (!result.rowCount) {
    const error = new Error('Leçon introuvable ou inscription active requise.');
    error.status = 404;
    throw error;
  }
  return result.rows[0];
}

module.exports = { listProducts, listMyProductAccesses, purchaseProduct, createProductDownloadUrl, listCourses, getCourse, enrollCourse, updateLessonProgress };
