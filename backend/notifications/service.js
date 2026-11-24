'use strict';
const { query } = require('../database/pool');

async function listNotifications(userId,limit=30){
 const n=Number(limit);
 if(!Number.isInteger(n)||n<1||n>100)throw new TypeError('Limite de notifications invalide.');
 const result=await query(
  `SELECT id,title,body,read_at,created_at FROM notifications
   WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,[userId,n]
 );
 return result.rows;
}
async function markNotificationRead(userId,id){
 const result=await query(
  `UPDATE notifications SET read_at=COALESCE(read_at,now())
   WHERE id=$1 AND user_id=$2 RETURNING id,read_at`,[id,userId]
 );
 if(!result.rowCount){const e=new Error('Notification introuvable.');e.status=404;throw e;}
 return result.rows[0];
}
module.exports={listNotifications,markNotificationRead};
