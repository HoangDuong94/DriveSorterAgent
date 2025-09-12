require('dotenv').config();
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

async function main() {
  const BUCKET = process.env.GCS_BUCKET;
  if (!BUCKET) throw new Error('GCS_BUCKET not configured');

  // Use explicit key if provided, else fall back to demo_key
  const rawKeys = String(process.env.ACCESS_KEYS || '').split(/[\s,]+/).filter(Boolean);
  const accessKey = rawKeys[0] || 'demo_key';
  const accessKeyHash = crypto.createHash('sha256').update(String(accessKey)).digest('hex');

  const storage = new Storage();
  const bucket = storage.bucket(BUCKET);

  const runId = `run_${new Date().toISOString()}_${crypto.randomBytes(4).toString('hex')}`;
  const status = {
    ok: true,
    runId,
    state: 'succeeded',
    mode: 'dry',
    meta: { accessKeyHash },
    summary: { processed: 0, moved: 0, errors: 0 }
  };

  const file = bucket.file(`runs/${runId}/status.json`);
  await file.save(JSON.stringify(status), { contentType: 'application/json' });
  console.log(JSON.stringify({ ok: true, runId, gsUri: `gs://${BUCKET}/runs/${runId}/status.json` }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

