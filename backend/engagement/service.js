'use strict';

const { query, transaction } = require('../database/pool');

async function getDailyQuestion() {
  const result = await query(
    `SELECT id,question_date,prompt,options
     FROM daily_questions WHERE active=true AND question_date=CURRENT_DATE
     ORDER BY id LIMIT 1`
  );
  return result.rowCount ? result.rows[0] : null;
}

function validateSelectedOption(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
    throw new TypeError('Réponse invalide.');
  }
  return value;
}

async function submitDailyAnswer(userId, questionId, selectedOption) {
  const selected = validateSelectedOption(selectedOption);
  return transaction(async tx => {
    const questionResult = await tx.query(
      `SELECT id,options,correct_option,reward_amount FROM daily_questions
       WHERE id=$1 AND active=true AND question_date=CURRENT_DATE FOR SHARE`,
      [questionId]
    );
    if (!questionResult.rowCount) {
      const error = new Error('Question du jour introuvable ou expirée.');
      error.status = 404;
      throw error;
    }
    const question = questionResult.rows[0];
    if (!Array.isArray(question.options) || selected >= question.options.length) {
      throw new TypeError('Option de réponse inexistante.');
    }
    const correct = selected === question.correct_option;
    const inserted = await tx.query(
      `INSERT INTO daily_question_answers(user_id,question_id,selected_option,is_correct,reward_amount)
       VALUES($1,$2,$3,$4,CASE WHEN $4 THEN $5 ELSE 0 END)
       ON CONFLICT(user_id,question_id) DO NOTHING
       RETURNING id,is_correct,reward_amount,answered_at`,
      [userId, questionId, selected, correct, question.reward_amount]
    );
    if (!inserted.rowCount) {
      const prior = await tx.query(
        `SELECT selected_option,is_correct,reward_amount,answered_at
         FROM daily_question_answers WHERE user_id=$1 AND question_id=$2`,
        [userId, questionId]
      );
      return { alreadyAnswered: true, ...prior.rows[0], reward_amount: String(prior.rows[0].reward_amount) };
    }
    const answer = inserted.rows[0];
    if (correct && BigInt(answer.reward_amount) > 0n) {
      const wallet = await tx.query(
        `SELECT id FROM wallets WHERE user_id=$1 AND wallet_type='earnings' AND currency='XOF' FOR UPDATE`,
        [userId]
      );
      if (!wallet.rowCount) {
        const error = new Error('Portefeuille de gains introuvable.');
        error.status = 500;
        throw error;
      }
      await tx.query('UPDATE wallets SET balance=balance+$1,updated_at=now() WHERE id=$2',[answer.reward_amount,wallet.rows[0].id]);
      await tx.query(
        `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
         VALUES($1,$2,'quiz_reward',$3,'XOF','daily_question_answer',$4,$5,'Récompense de la question du jour')`,
        [wallet.rows[0].id,userId,answer.reward_amount,answer.id,`daily-question-reward:${answer.id}`]
      );
    }
    return { alreadyAnswered: false, ...answer, reward_amount: String(answer.reward_amount) };
  });
}

async function claimProductReward(userId, accessId) {
  return transaction(async tx => {
    const accessResult = await tx.query(
      `SELECT a.id,a.user_id,a.purchased_at,a.expires_at,p.daily_reward,p.access_days
       FROM product_accesses a JOIN products p ON p.id=a.product_id
       WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a`,
      [accessId, userId]
    );
    if (!accessResult.rowCount) {
      const error = new Error('Accès produit introuvable.');
      error.status = 404;
      throw error;
    }
    const access = accessResult.rows[0];
    if (Number(access.daily_reward) <= 0 || Number(access.access_days) <= 0 ||
        (access.expires_at && new Date(access.expires_at) <= new Date())) {
      const error = new Error('Cette offre ne donne pas droit à une récompense disponible.');
      error.status = 409;
      throw error;
    }
    const eligible = await tx.query(
      `SELECT LEAST(GREATEST(FLOOR(EXTRACT(EPOCH FROM (now()-$1::timestamptz))/86400)::int+1,1),$2)::int AS reward_number`,
      [access.purchased_at, access.access_days]
    );
    const rewardNumber = eligible.rows[0].reward_number;
    const already = await tx.query(
      `SELECT id FROM product_reward_credits
       WHERE product_access_id=$1 AND reward_number=$2`,
      [access.id, rewardNumber]
    );
    if (already.rowCount) {
      const error = new Error('La récompense de cette journée a déjà été réclamée.');
      error.status = 409;
      throw error;
    }
    const wallet = await tx.query(
      `SELECT id FROM wallets WHERE user_id=$1 AND wallet_type='earnings' AND currency='XOF' FOR UPDATE`,
      [userId]
    );
    if (!wallet.rowCount) {
      const error = new Error('Portefeuille de gains introuvable.');
      error.status = 500;
      throw error;
    }
    const credit = await tx.query(
      `INSERT INTO product_reward_credits(product_access_id,user_id,reward_number,amount)
       VALUES($1,$2,$3,$4) RETURNING id,amount,created_at`,
      [access.id,userId,rewardNumber,access.daily_reward]
    );
    await tx.query('UPDATE wallets SET balance=balance+$1,updated_at=now() WHERE id=$2', [access.daily_reward,wallet.rows[0].id]);
    await tx.query(
      `INSERT INTO ledger_entries(wallet_id,user_id,entry_type,amount,currency,reference_type,reference_id,idempotency_key,description)
       VALUES($1,$2,'product_reward',$3,'XOF','product_reward',$4,$5,$6)`,
      [wallet.rows[0].id,userId,access.daily_reward,credit.rows[0].id,
       `product-reward:${access.id}:${rewardNumber}`,`Récompense produit jour ${rewardNumber}`]
    );
    await tx.query('UPDATE product_accesses SET rewards_paid_at=now() WHERE id=$1',[access.id]);
    return { ...credit.rows[0], amount: String(credit.rows[0].amount), rewardNumber };
  });
}

module.exports = { getDailyQuestion, submitDailyAnswer, claimProductReward, validateSelectedOption };
