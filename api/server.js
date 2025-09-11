require('dotenv').config();
const fastifyFactory = require('fastify');

async function buildServer() {
  const app = fastifyFactory({ logger: true });

  // CORS for PWA usage
  await app.register(require('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Access-Key']
  });

  // Auth hook (minimal now; Secret Manager integration via services/auth)
  app.addHook('onRequest', async (req, reply) => {
    if (['/healthz', '/readyz', '/version'].includes(req.url)) return;

    const provided = req.headers['x-access-key'];
    if (!provided) return reply.code(401).send({ error: { code: 401, message: 'Unauthorized' } });

    try {
      const providedStr = String(provided);
      const envList = String(process.env.ACCESS_KEYS || '').split(/[,\s]+/).filter(Boolean);
      const useEnv = (process.env.ACCESS_KEYS_SOURCE || '').toLowerCase() === 'env' || envList.length > 0;
      if (useEnv) {
        if (!envList.includes(providedStr)) return reply.code(403).send({ error: { code: 403, message: 'Forbidden' } });
        return; // authorized
      }
      // default to Secret Manager
      const { loadKeysFromSecret } = require('../services/auth');
      const keys = await loadKeysFromSecret();
      if (!keys.has(providedStr)) return reply.code(403).send({ error: { code: 403, message: 'Forbidden' } });
    } catch (e) {
      req.log.error({ err: e }, 'access-key verification failed');
      return reply.code(500).send({ error: { code: 500, message: 'Auth error' } });
    }
  });

  // Basic health endpoints
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/version', async () => ({ version: process.env.DS_VERSION || 'dev', region: process.env.REGION || null }));

  // Routes
  app.register(require('./routes/health'));
  app.register(require('./routes/onboard'), { prefix: '/api/onboard' });
  app.register(require('./routes/runs'), { prefix: '/api' });

  return app;
}

// Start if invoked directly
if (require.main === module) {
  (async () => {
    const app = await buildServer();
    const port = process.env.PORT ? Number(process.env.PORT) : 8080;
    const host = '0.0.0.0';
    try {
      await app.listen({ port, host });
      app.log.info(`API listening on http://${host}:${port}`);
      console.log('AUTH SRC=', process.env.ACCESS_KEYS_SOURCE || '(none)', 'ACCESS_KEYS=', process.env.ACCESS_KEYS || '(none)');
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  })();
}

module.exports = buildServer;
