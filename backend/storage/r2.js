'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('node:crypto');

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
  const raw = String(value || 'fructy-download')
    .replace(/\\/g, '/').split('/').pop() || 'fructy-download';
  const stem = raw.replace(/\.pdf$/i, '');
  const base = stem.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '').trim()
    .replace(/[ .]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'fructy-download';
  return base + '.pdf';
}
function validatePdfUpload({ filename, size, contentType }) {
  const name = String(filename || '').trim();
  const bytes = Number(size);
  if (!name || name.length > 240 || !/\.pdf$/i.test(name) ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 25 * 1024 * 1024 ||
      String(contentType || '').toLowerCase() !== 'application/pdf') {
    const error = new Error('Choisis un fichier PDF valide de 25 Mo maximum.');
    error.status = 400;
    error.code = 'INVALID_PDF_UPLOAD';
    throw error;
  }
  return { key: 'products/' + randomUUID() + '.pdf', contentType: 'application/pdf' };
}
async function createUploadUrl(input) {
  const bucket = requiredEnv('R2_BUCKET');
  const upload = validatePdfUpload(input || {});
  const command = new PutObjectCommand({
    Bucket: bucket, Key: upload.key, ContentType: upload.contentType
  });
  return {
    key: upload.key,
    url: await getSignedUrl(getClient(), command, { expiresIn: 300 }),
    expiresIn: 300
  };
}
async function createDownloadUrl(key, productName) {
  const bucket = requiredEnv('R2_BUCKET');
  const objectKey = String(key || '').trim();
  if (!objectKey || !/\.pdf$/i.test(objectKey) || objectKey.length > 1024 || objectKey.startsWith('/') ||
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
module.exports = { createDownloadUrl, createUploadUrl, validatePdfUpload, safeFilename };
