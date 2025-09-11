const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const { runSorter } = require('./driveSorter');
const { loadUserConfig } = require('./configStore');
const crypto = require('crypto');

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET;

async function writeStatus(runId, obj) {
  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(`runs/${runId}/status.json`);
  // Preserve existing meta unless explicitly provided
  try {
    const [exists] = await file.exists();
    if (exists) {
      const [buf] = await file.download();
      try {
        const prev = JSON.parse(buf.toString('utf8'));
        if (prev && prev.meta && !obj.meta) obj.meta = prev.meta;
      } catch {}
    }
  } catch {}
  await file.save(JSON.stringify(obj), { contentType: 'application/json' });
  // ensure logs file exists (best-effort)
  try { await bucket.file(`runs/${runId}/logs.ndjson`).save('\n', { resumable: false, contentType: 'application/x-ndjson' }); } catch {}
}

async function appendLog(runId, entry) {
  const file = storage.bucket(BUCKET).file(`runs/${runId}/logs.ndjson`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  // naive: overwrite or create; in Cloud Run, prefer composing/appending; keep simple here
  try {
    const [exists] = await file.exists();
    if (!exists) return await file.save(line, { resumable: false, contentType: 'application/x-ndjson' });
    const [buf] = await file.download();
    await file.save(Buffer.concat([buf, Buffer.from(line)]), { resumable: false, contentType: 'application/x-ndjson' });
  } catch (_) {
    await file.save(line, { resumable: false, contentType: 'application/x-ndjson' });
  }
}

async function startDryRun({ email, accessKeyHash }) {
  const cfg = await loadUserConfig(email);
  if (!cfg) return { ok: false, error: 'config-not-found' };
  const runId = `run_${new Date().toISOString()}_${uuidv4().slice(0,8)}`;
  try {
    // Ensure logs file exists
    await storage.bucket(BUCKET).file(`runs/${runId}/logs.ndjson`).save('', { resumable: false, contentType: 'application/x-ndjson' });
    await writeStatus(runId, { ok: true, runId, state: 'running', mode: 'dry', meta: { email, accessKeyHash } });
    await appendLog(runId, { level: 'info', msg: 'dry-run started', email });
    const summary = await runSorter({
      sourceFolderId: cfg.sourceFolderId,
      targetRootFolderId: cfg.targetRootFolderId,
      dryRun: true,
      userEmail: email,
      gcsPrefix: cfg.gcsPrefix,
      onLog: (e) => appendLog(runId, { level: 'info', msg: e }),
      onProgress: (p) => writeStatus(runId, { ok: true, runId, state: 'running', mode: 'dry', progress: p }),
    });
    await writeStatus(runId, { ok: true, runId, state: 'succeeded', mode: 'dry', summary });
    await appendLog(runId, { level: 'info', msg: 'dry-run finished', email });
    return { ok: true, runId, summary, artifacts: [{ type: 'json', gcs: `gs://${BUCKET}/runs/${runId}/status.json` }] };
  } catch (e) {
    await writeStatus(runId, { ok: false, runId, state: 'failed', mode: 'dry', error: e.message });
    await appendLog(runId, { level: 'error', msg: 'dry-run failed', error: e.message });
    return { ok: false, error: 'run-error', detail: e.message, runId };
  }
}

async function startRun({ email, accessKeyHash }) {
  const cfg = await loadUserConfig(email);
  if (!cfg) return { ok: false, error: 'config-not-found' };
  const runId = `run_${new Date().toISOString()}_${uuidv4().slice(0,8)}`;
  (async () => {
    try {
      // Ensure logs file exists
      await storage.bucket(BUCKET).file(`runs/${runId}/logs.ndjson`).save('', { resumable: false, contentType: 'application/x-ndjson' });
      await writeStatus(runId, { ok: true, runId, state: 'running', mode: 'run', meta: { email, accessKeyHash } });
      await appendLog(runId, { level: 'info', msg: 'run started', email });
      const summary = await runSorter({
        sourceFolderId: cfg.sourceFolderId,
        targetRootFolderId: cfg.targetRootFolderId,
        dryRun: false,
        userEmail: email,
        gcsPrefix: cfg.gcsPrefix,
        onLog: (e) => appendLog(runId, { level: 'info', msg: e }),
        onProgress: (p) => writeStatus(runId, { ok: true, runId, state: 'running', mode: 'run', progress: p }),
      });
      await writeStatus(runId, { ok: true, runId, state: 'succeeded', mode: 'run', summary });
      await appendLog(runId, { level: 'info', msg: 'run finished', email });
    } catch (e) {
      await writeStatus(runId, { ok: false, runId, state: 'failed', mode: 'run', error: e.message });
      await appendLog(runId, { level: 'error', msg: 'run failed', error: e.message });
    }
  })();
  return { ok: true, runId };
}

async function getRunStatus(runId) {
  const file = storage.bucket(BUCKET).file(`runs/${runId}/status.json`);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString('utf8'));
}

async function getArtifactsSignedUrls(runId, ttlSec, providedAccessKeyHash) {
  const bucket = storage.bucket(BUCKET);
  const statusFile = bucket.file(`runs/${runId}/status.json`);
  const [exists] = await statusFile.exists();
  if (!exists) return { notFound: true };
  const [buf] = await statusFile.download();
  let status;
  try { status = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('invalid-status-json'); }
  const meta = status && status.meta ? status.meta : {};
  const email = meta.email || null;
  const emailHash = email ? crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex') : null;
  const expectedHash = meta.accessKeyHash || null;
  if (!expectedHash || !providedAccessKeyHash || expectedHash !== providedAccessKeyHash) {
    return { forbidden: true };
  }

  const expiresAt = Date.now() + (Math.max(60, Math.min(86400, Math.floor(ttlSec || 3600))) * 1000);
  const expires = new Date(expiresAt);

  const out = {};
  const [statusUrl] = await statusFile.getSignedUrl({ version: 'v4', action: 'read', expires });
  out.statusUrl = statusUrl;

  const logsFile = bucket.file(`runs/${runId}/logs.ndjson`);
  try {
    const [logExists] = await logsFile.exists();
    if (logExists) {
      const [logsUrl] = await logsFile.getSignedUrl({ version: 'v4', action: 'read', expires });
      out.logsUrl = logsUrl;
    }
  } catch {}

  // basic log (caller should log as well)
  try { console.log(JSON.stringify({ evt: 'artifacts-signed', runId, emailHash, ttlSec, hasLogs: !!out.logsUrl })); } catch {}

  return out;
}

module.exports = { startDryRun, startRun, getRunStatus, getArtifactsSignedUrls };
