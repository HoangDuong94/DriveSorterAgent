module.exports = async function (app) {
  const runs = require('../../services/runsStore');
  const crypto = require('crypto');

  function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

  app.post('/dry-run', async (req, reply) => {
    const { email } = req.body || {};
    if (!email) return reply.code(422).send({ error: { code: 422, message: 'missing-email' } });
    const accessKey = req.headers['x-access-key'];
    const accessKeyHash = accessKey ? sha256Hex(accessKey) : null;
    const res = await runs.startDryRun({ email, accessKeyHash });
    if (!res.ok) {
      const status = res.error === 'config-not-found' ? 404 : 500;
      return reply.code(status).send(res);
    }
    return reply.send(res);
  });

  app.post('/run', async (req, reply) => {
    const { email } = req.body || {};
    if (!email) return reply.code(422).send({ error: { code: 422, message: 'missing-email' } });
    const accessKey = req.headers['x-access-key'];
    const accessKeyHash = accessKey ? sha256Hex(accessKey) : null;
    const res = await runs.startRun({ email, accessKeyHash });
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

  // New: Signed artifact URLs
  app.get('/runs/:runId/artifacts', async (req, reply) => {
    const runId = req.params.runId;
    let ttlSec = Number(req.query.ttlSec || 3600);
    if (!Number.isFinite(ttlSec)) ttlSec = 3600;
    ttlSec = Math.max(60, Math.min(86400, Math.floor(ttlSec)));
    const accessKey = req.headers['x-access-key'];
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
};
