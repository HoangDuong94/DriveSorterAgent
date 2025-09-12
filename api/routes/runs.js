module.exports = async function (app) {
  const runs = require('../../services/runsStore');
  const crypto = require('crypto');

  function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

  app.post('/dry-run', async (req, reply) => {
    const body = req.body || {};
    const { email, profileId } = body;
    if (!email && !profileId) return reply.code(422).send({ error: { code: 422, message: 'missing-fields', detail: 'profileId|email' } });
    const accessKey = req.accessKey || null;
    const accessKeyHash = accessKey ? sha256Hex(accessKey) : null;
    const ownerHash = req.ownerHash || (accessKey ? sha256Hex(accessKey) : null);
    const res = await runs.startDryRun({ email, profileId, ownerHash, accessKeyHash });
    if (!res.ok) {
      const status = res.error === 'config-not-found' ? 404 : 500;
      return reply.code(status).send(res);
    }
    return reply.send(res);
  });

  app.post('/run', async (req, reply) => {
    const body = req.body || {};
    const { email, profileId } = body;
    if (!email && !profileId) return reply.code(422).send({ error: { code: 422, message: 'missing-fields', detail: 'profileId|email' } });
    const accessKey = req.accessKey || null;
    const accessKeyHash = accessKey ? sha256Hex(accessKey) : null;
    const ownerHash = req.ownerHash || (accessKey ? sha256Hex(accessKey) : null);
    const res = await runs.startRun({ email, profileId, ownerHash, accessKeyHash });
    if (!res.ok) {
      const status = res.error === 'config-not-found' ? 404 : 500;
      return reply.code(status).send(res);
    }
    return reply.code(202).send(res);
  });

  app.get('/runs/:runId', async (req, reply) => {
    const st = await runs.getRunStatus(req.params.runId);
    if (!st) return reply.code(404).send({ error: { code: 404, message: 'run-not-found' } });
    return reply.send(st);
  });

  // List recent runs for current access key (cookie session only)
  app.get('/runs', async (req, reply) => {
    try {
      const accessKey = req.accessKey || null;
      if (!accessKey) return reply.code(401).send({ error: { code: 401, message: 'unauthorized' } });
      const accessKeyHash = sha256Hex(accessKey);
      let limit = Number(req.query && req.query.limit || 20);
      if (!Number.isFinite(limit)) limit = 20;
      limit = Math.max(1, Math.min(100, Math.floor(limit)));
      const items = await runs.listRunsByAccessKey(accessKeyHash, limit);
      return reply.send({ ok: true, items });
    } catch (e) {
      req.log.error({ err: e }, 'runs-list-failed');
      return reply.code(500).send({ error: { code: 500, message: 'runs-list-error', detail: e.message } });
    }
  });

  // New: Signed artifact URLs (session cookie only)
  app.get('/runs/:runId/artifacts', async (req, reply) => {
    const runId = req.params.runId;
    let ttlSec = Number(req.query.ttlSec || 3600);
    if (!Number.isFinite(ttlSec)) ttlSec = 3600;
    ttlSec = Math.max(60, Math.min(86400, Math.floor(ttlSec)));
    const accessKey = req.accessKey || null;
    const accessKeyHash = accessKey ? sha256Hex(accessKey) : null;
    try {
      const out = await runs.getArtifactsSignedUrls(runId, ttlSec, accessKeyHash);
      if (out && out.notFound) return reply.code(404).send({ error: { code: 404, message: 'run-not-found' } });
      if (out && out.forbidden) return reply.code(403).send({ error: { code: 403, message: 'forbidden-run-ownership' } });
      return reply.send({ ok: true, runId, ...out });
    } catch (e) {
      req.log.error({ err: e, runId, ttlSec }, 'artifacts-url-failed');
      return reply.code(500).send({ error: { code: 500, message: 'artifacts-error', detail: e.message } });
    }
  });

  // New: SSE stream of status.json
  app.get('/runs/:runId/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders && reply.raw.flushHeaders();

    const runId = req.params.runId;
    let closed = false;
    req.raw.on('close', () => { closed = true; });

    const send = async () => {
      try {
        const st = await runs.getRunStatus(runId);
        if (!st) {
          reply.raw.write(`event: error\n`);
          reply.raw.write(`data: ${JSON.stringify({ error: { code: 404, message: 'run-not-found' } })}\n\n`);
          reply.raw.end();
          return true;
        }
        reply.raw.write(`data: ${JSON.stringify(st)}\n\n`);
        if (st && (st.state === 'succeeded' || st.state === 'failed')) {
          reply.raw.end();
          return true;
        }
      } catch (e) {
        reply.raw.write(`event: error\n`);
        reply.raw.write(`data: ${JSON.stringify({ error: { code: 500, message: 'stream-error', detail: e.message } })}\n\n`);
      }
      return false;
    };

    // initial push
    if (await send()) return;
    const iv = setInterval(async () => {
      if (closed) { clearInterval(iv); return; }
      const done = await send();
      if (done) { clearInterval(iv); }
    }, 1000);
  });
};
