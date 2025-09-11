const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET;

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex');
}

async function saveUserConfig({ email, sourceFolderId, targetRootFolderId }) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const h = emailHash(email);
  const file = storage.bucket(BUCKET).file(`configs/${h}.json`);
  const cfg = {
    email, sourceFolderId, targetRootFolderId,
    gcsPrefix: `users/${h}`,
    settings: {
      allow_new_subfolders: false,
      duplicates: { policy: 'skip', rename_suffix: 'dup', subfolder_name: 'Duplikate' }
    },
    updatedAt: new Date().toISOString(),
  };
  await file.save(JSON.stringify(cfg, null, 2), { contentType: 'application/json' });
  return { gsUri: `gs://${BUCKET}/configs/${h}.json`, userHash: h };
}

async function loadUserConfig(email) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const h = emailHash(email);
  const file = storage.bucket(BUCKET).file(`configs/${h}.json`);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { saveUserConfig, loadUserConfig, emailHash };

