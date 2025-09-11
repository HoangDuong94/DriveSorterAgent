let LRUCache = require('lru-cache');
// Support both v6 and v10+ exports
LRUCache = LRUCache && LRUCache.LRUCache ? LRUCache.LRUCache : LRUCache;

const cache = new LRUCache({ max: 1, ttl: 5 * 60 * 1000 }); // 5 min
const SECRET_NAME = process.env.ACCESS_KEYS_SECRET_NAME || 'drivesorter-access-keys';

async function loadKeysFromSecret() {
  const cached = cache.get('keys');
  if (cached) return cached;
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const projectId = process.env.GCP_PROJECT_ID;
  const name = `projects/${projectId}/secrets/${SECRET_NAME}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name });
  const content = version.payload.data.toString('utf8');
  const keys = new Set(content.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  cache.set('keys', keys);
  return keys;
}

module.exports = { loadKeysFromSecret };
