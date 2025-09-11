const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

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

// --- Profiles (owners/<ownerHash>) ---

function profilePath(ownerHash, profileId) {
  return `configs/owners/${ownerHash}/profiles/${profileId}.json`;
}

function defaultPath(ownerHash) {
  return `configs/owners/${ownerHash}/default.json`;
}

async function saveProfile({ ownerHash, profile }) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  if (!ownerHash) throw new Error('ownerHash required');
  const storage = new Storage();
  const id = (profile && profile.id) ? String(profile.id) : `pr_${uuidv4().slice(0,8)}`;
  const now = new Date().toISOString();
  const data = {
    id,
    label: profile.label || id,
    sourceFolderId: profile.sourceFolderId,
    targetRootFolderId: profile.targetRootFolderId,
    settings: profile.settings || {},
    gcsPrefix: `users/${ownerHash}`,
    updatedAt: now,
  };
  const file = storage.bucket(BUCKET).file(profilePath(ownerHash, id));
  await file.save(JSON.stringify(data, null, 2), { contentType: 'application/json' });
  return data;
}

async function listProfiles(ownerHash) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: `configs/owners/${ownerHash}/profiles/` });
  const items = [];
  for (const f of files) {
    try {
      const [buf] = await f.download();
      items.push(JSON.parse(buf.toString('utf8')));
    } catch (_) { /* ignore malformed */ }
  }
  let defaultId = null;
  try {
    const defFile = storage.bucket(BUCKET).file(defaultPath(ownerHash));
    const [exists] = await defFile.exists();
    if (exists) {
      const [buf] = await defFile.download();
      const parsed = JSON.parse(buf.toString('utf8'));
      defaultId = parsed && parsed.id ? String(parsed.id) : null;
    }
  } catch (_) {}
  return { items, defaultId };
}

async function setDefaultProfile(ownerHash, id) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const file = storage.bucket(BUCKET).file(defaultPath(ownerHash));
  const payload = { id: String(id), updatedAt: new Date().toISOString() };
  await file.save(JSON.stringify(payload), { contentType: 'application/json' });
  return payload;
}

async function getDefaultProfileId(ownerHash) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const file = storage.bucket(BUCKET).file(defaultPath(ownerHash));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && parsed.id ? String(parsed.id) : null;
  } catch (_) { return null; }
}

async function getProfile(ownerHash, id) {
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');
  const storage = new Storage();
  const file = storage.bucket(BUCKET).file(profilePath(ownerHash, id));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString('utf8'));
}

module.exports = {
  saveUserConfig,
  loadUserConfig,
  emailHash,
  saveProfile,
  listProfiles,
  setDefaultProfile,
  getDefaultProfileId,
  getProfile,
};
