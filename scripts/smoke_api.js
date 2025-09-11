// Minimal smoke tests using Fastify.inject (no external services)
process.env.ACCESS_KEYS_SOURCE = 'env';
process.env.ACCESS_KEYS = 'demo_key';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret';

(async () => {
  const buildServer = require('../api/server');
  const app = await buildServer();

  function assert(cond, msg) {
    if (!cond) throw new Error('ASSERT: ' + msg);
  }

  // version should be public
  const v = await app.inject({ method: 'GET', url: '/version' });
  assert(v.statusCode === 200, '/version should return 200');

  // session (no auth) with wrong key
  let r = await app.inject({ method: 'POST', url: '/api/session', payload: { accessKey: 'wrong' } });
  assert(r.statusCode === 403, 'session with wrong key should be 403');

  // session (no auth) with valid key
  r = await app.inject({ method: 'POST', url: '/api/session', payload: { accessKey: 'demo_key' } });
  assert(r.statusCode === 200, 'session with valid key should be 200');
  const rawCookie = r.headers['set-cookie'];
  const setCookie = Array.isArray(rawCookie) ? rawCookie : (rawCookie ? [rawCookie] : []);
  assert(setCookie.length && setCookie.join(' ').includes('ds_session='), 'Set-Cookie should contain ds_session');

  // protected route without auth → 401
  let p = await app.inject({ method: 'GET', url: '/api/profiles' });
  assert(p.statusCode === 401, 'GET /api/profiles without auth should be 401');

  // protected route with cookie auth (still expect failure due to missing GCS, but not 401)
  p = await app.inject({ method: 'GET', url: '/api/profiles', headers: { cookie: setCookie } });
  assert(p.statusCode !== 401, 'GET /api/profiles with cookie should not be 401');

  // runs validation should require profileId or email
  let rDry = await app.inject({ method: 'POST', url: '/api/dry-run', headers: { cookie: setCookie }, payload: {} });
  assert(rDry.statusCode === 422, 'POST /api/dry-run without fields should be 422');
  let rRun = await app.inject({ method: 'POST', url: '/api/run', headers: { cookie: setCookie }, payload: {} });
  assert(rRun.statusCode === 422, 'POST /api/run without fields should be 422');

  // onboard resolve requires auth
  let rResNoAuth = await app.inject({ method: 'GET', url: '/api/onboard/resolve?q=name' });
  assert(rResNoAuth.statusCode === 401, 'GET /resolve without auth should be 401');
  let rRes = await app.inject({ method: 'GET', url: '/api/onboard/resolve?q=name', headers: { cookie: setCookie } });
  assert(rRes.statusCode !== 401, 'GET /resolve with cookie should not be 401');

  console.log('SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE FAILED:', e.message);
  process.exit(1);
});
