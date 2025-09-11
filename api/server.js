require('dotenv').config();
const fastifyFactory = require('fastify');
const crypto = require('crypto');

async function buildServer() {
  const app = fastifyFactory({ logger: true });

  // CORS for PWA usage
  await app.register(require('@fastify/cors'), {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Access-Key']
  });

  // Cookie support (session via HttpOnly cookie)
  await app.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || undefined,
    hook: 'onRequest',
    parseOptions: {
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
      httpOnly: true,
      path: '/',
    },
  });

  // Auth hook (accepts header X-Access-Key OR cookie ds_session)
  app.addHook('onRequest', async (req, reply) => {
    if (['/healthz', '/readyz', '/version', '/api/session'].includes(req.url)) return;

    const provided = req.headers['x-access-key'] || (req.cookies && (req.cookies.ds_session || req.cookies['ds_session']));
    if (!provided) return reply.code(401).send({ error: { code: 401, message: 'unauthorized' } });

    try {
      const providedStr = String(provided);
      const envList = String(process.env.ACCESS_KEYS || '').split(/[,\s]+/).filter(Boolean);
      const useEnv = (process.env.ACCESS_KEYS_SOURCE || '').toLowerCase() === 'env' || envList.length > 0;
      if (useEnv) {
        if (!envList.includes(providedStr)) return reply.code(403).send({ error: { code: 403, message: 'forbidden' } });
        // attach identity for downstream
        req.accessKey = providedStr;
        req.ownerHash = crypto.createHash('sha256').update(providedStr).digest('hex');
        return; // authorized
      }
      // default to Secret Manager
      const { loadKeysFromSecret } = require('../services/auth');
      const keys = await loadKeysFromSecret();
      if (!keys.has(providedStr)) return reply.code(403).send({ error: { code: 403, message: 'forbidden' } });
      req.accessKey = providedStr;
      req.ownerHash = crypto.createHash('sha256').update(providedStr).digest('hex');
    } catch (e) {
      req.log.error({ err: e }, 'access-key verification failed');
      return reply.code(500).send({ error: { code: 500, message: 'auth-error' } });
    }
  });

  // Session endpoint: set cookie from provided accessKey
  app.post('/api/session', async (req, reply) => {
    try {
      const body = req.body || {};
      const accessKey = body && body.accessKey ? String(body.accessKey) : '';
      if (!accessKey) return reply.code(422).send({ error: { code: 422, message: 'missing-fields', detail: 'accessKey' } });

      const envList = String(process.env.ACCESS_KEYS || '').split(/[,\s]+/).filter(Boolean);
      const useEnv = (process.env.ACCESS_KEYS_SOURCE || '').toLowerCase() === 'env' || envList.length > 0;
      let valid = false;
      if (useEnv) {
        valid = envList.includes(accessKey);
      } else {
        const { loadKeysFromSecret } = require('../services/auth');
        const keys = await loadKeysFromSecret();
        valid = keys.has(accessKey);
      }
      if (!valid) return reply.code(403).send({ error: { code: 403, message: 'forbidden' } });

      reply.setCookie('ds_session', accessKey, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === '1',
        path: '/',
      });
      return reply.send({ ok: true });
    } catch (e) {
      req.log.error({ err: e }, 'session-init failed');
      return reply.code(500).send({ error: { code: 500, message: 'internal', detail: e.message } });
    }
  });

  // Basic health endpoints
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/version', async () => ({ version: process.env.DS_VERSION || 'dev', region: process.env.REGION || null }));

  // Routes
  app.register(require('./routes/health'));
  app.register(require('./routes/onboard'), { prefix: '/api/onboard' });
  app.register(require('./routes/profiles'), { prefix: '/api' });
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
