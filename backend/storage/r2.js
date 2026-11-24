'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client;
function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error('Stockage privé non configuré. Contacte l’équipe Fructy.');
    error.status = 503;
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  return value;
}
function getClient() {
  if (client) return client;
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    const error = new Error('Identifiant de compte R2 invalide.');
    error.status = 503;
    throw error;
  }
  client = new S3Client({
    region: 'auto',
    endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId, secretAccessKey }
  });
  return client;
}
function safeFilename(value) {
  const base = String(value || 'fructy-download')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '').trim()
    .replace(/[ .]+/g, '-').slice(0, 100) || 'fructy-download';
  return base.endsWith('.pdf') ? base : base + '.pdf';
}
async function createDownloadUrl(key, productName) {
  const bucket = requiredEnv('R2_BUCKET');
  const objectKey = String(key || '').trim();
  if (!objectKey || objectKey.length > 1024 || objectKey.startsWith('/') ||
      objectKey.split('/').some(part => part === '..') || /[\r\n\0]/.test(objectKey)) {
    const error = new Error('Référence de fichier invalide.');
    error.status = 500;
    throw error;
  }
  const command = new GetObjectCommand({
    Bucket: bucket, Key: objectKey,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: 'attachment; filename="' + safeFilename(productName) + '"'
  });
  return getSignedUrl(getClient(), command, { expiresIn: 60 });
}
module.exports = { createDownloadUrl, safeFilename };
