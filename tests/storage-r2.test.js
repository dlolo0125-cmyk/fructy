'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeFilename, createDownloadUrl, validatePdfUpload } = require('../backend/storage/r2');

test('nom de téléchargement nettoyé et suffixe PDF', () => {
  assert.equal(safeFilename('Guide débutant'), 'Guide-debutant.pdf');
  assert.equal(safeFilename('mon-fichier.pdf'), 'mon-fichier.pdf');
  assert.equal(safeFilename('../../evil\r\n.pdf'), 'evil.pdf');
});

test('URL de téléchargement refusée sans bucket R2 configuré', async () => {
  const previous = process.env.R2_BUCKET;
  delete process.env.R2_BUCKET;
  try {
    await assert.rejects(
      createDownloadUrl('products/test.pdf', 'Test'),
      error => error.status === 503 && error.code === 'STORAGE_NOT_CONFIGURED'
    );
  } finally {
    if (previous === undefined) delete process.env.R2_BUCKET;
    else process.env.R2_BUCKET = previous;
  }
});

test('validation des PDF avant génération du lien d’upload', () => {
  const upload = validatePdfUpload({ filename: 'cours.pdf', size: 1024, contentType: 'application/pdf' });
  assert.match(upload.key, /^products\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(upload.contentType, 'application/pdf');
  assert.throws(() => validatePdfUpload({ filename: 'virus.exe', size: 10, contentType: 'application/pdf' }), /PDF valide/);
  assert.throws(() => validatePdfUpload({ filename: 'trop-grand.pdf', size: 26 * 1024 * 1024, contentType: 'application/pdf' }), /PDF valide/);
  assert.throws(() => validatePdfUpload({ filename: 'vide.pdf', size: 0, contentType: 'application/pdf' }), /PDF valide/);
});
