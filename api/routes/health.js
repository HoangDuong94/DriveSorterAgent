module.exports = async function (app) {
  app.get('/readyz', async (req, reply) => {
    const out = { ok: true, components: {} };
    try {
      const { Storage } = require('@google-cloud/storage');
      const storage = new Storage();
      const bucketName = process.env.GCS_BUCKET;
      if (bucketName) {
        const [exists] = await storage.bucket(bucketName).exists();
        out.components.storage = !!exists;
      } else {
        out.components.storage = true;
      }
    } catch (e) {
      out.ok = false; out.components.storage = false; out.error = e.message;
    }

    // Secret check (optional): ensures Secret Manager access is working when configured
    try {
      if ((process.env.ACCESS_KEYS_SOURCE || 'secret') === 'secret') {
        const { loadKeysFromSecret } = require('../../services/auth');
        const keys = await loadKeysFromSecret();
        out.components.secrets = keys instanceof Set && keys.size >= 0;
      } else {
        out.components.secrets = true;
      }
    } catch (e) {
      out.ok = false; out.components.secrets = false; out.error = e.message;
    }

    // Vision client init
    try {
      const { v1: vision } = require('@google-cloud/vision');
      // Creating client is a decent smoke test for ADC/credentials
      // eslint-disable-next-line no-new
      new vision.ImageAnnotatorClient();
      out.components.vision = true;
    } catch (e) {
      out.ok = false; out.components.vision = false; out.error = e.message;
    }

    return reply.code(out.ok ? 200 : 500).send(out);
  });

  // Debug-only helper to inspect env during local tests
  app.get('/env', async (req, reply) => {
    return reply.send({
      ACCESS_KEYS_SOURCE: process.env.ACCESS_KEYS_SOURCE || null,
      ACCESS_KEYS: process.env.ACCESS_KEYS || null,
    });
  });
};
