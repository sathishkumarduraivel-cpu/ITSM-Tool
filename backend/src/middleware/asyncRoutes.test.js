import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { protectAsyncRoutes } from './asyncRoutes.js';

// Builds a throwaway app shaped like the real one: a router mounted under a
// prefix, an async handler that rejects, and the same style of error handler
// index.js installs at the bottom.
function buildApp({ guard }) {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  router.get('/throws', async () => {
    throw new Error('deliberate async failure');
  });
  router.get('/rejects', async () => {
    await Promise.resolve();
    return Promise.reject(new Error('deliberate rejection'));
  });
  router.get('/fine', async (req, res) => {
    res.json({ ok: true });
  });
  router.get('/sync-throws', () => {
    throw new Error('deliberate sync failure');
  });
  app.use('/api/probe', router);

  if (guard) protectAsyncRoutes(app);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));

// A hang is the failure being guarded against, so every request is given a
// deadline -- without one a regression would stall the suite instead of
// failing it.
async function get(server, path, ms = 3000) {
  const { port } = server.address();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'NO RESPONSE', body: '' };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Not asserted here: that an UNGUARDED async throw never answers at all.
// It is the defect this module exists for, and it was confirmed by running
// exactly that case (the request aborted after 1.5s with no response), but
// node:test reports the resulting stray unhandledRejection as a file-level
// failure whatever listeners are attached -- so demonstrating the bug and
// keeping the suite green are mutually exclusive. The fix is asserted
// instead, which is what has to keep working.
describe('async route guard', () => {
  let guarded;

  before(async () => { guarded = await listen(buildApp({ guard: true })); });
  after(async () => { await close(guarded); });

  test('a guarded async throw answers with 500', async () => {
    const r = await get(guarded, '/api/probe/throws');
    assert.equal(r.status, 500);
    assert.match(r.body, /Internal server error/);
  });

  test('a guarded async rejection answers with 500', async () => {
    const r = await get(guarded, '/api/probe/rejects');
    assert.equal(r.status, 500);
  });

  test('a handler that works is untouched', async () => {
    const r = await get(guarded, '/api/probe/fine');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
  });

  test('a synchronous throw still reaches the error handler', async () => {
    // Express already handled this case; the guard must not change it.
    const r = await get(guarded, '/api/probe/sync-throws');
    assert.equal(r.status, 500);
  });

  test('it reports how many handlers it wrapped, and skips synchronous ones', () => {
    const app = express();
    const router = express.Router();
    router.get('/a', async (req, res) => res.end());
    router.post('/b', async (req, res) => res.end());
    router.get('/c', (req, res) => res.end());
    app.use('/x', router);
    const stats = protectAsyncRoutes(app);
    assert.equal(stats.wrapped, 2, 'the two async handlers');
    assert.ok(stats.skipped >= 1, 'the synchronous one is left alone');
  });

  test('running twice does not double-count the same router', () => {
    const app = express();
    const router = express.Router();
    router.get('/a', async (req, res) => res.end());
    app.use('/x', router);
    protectAsyncRoutes(app);
    const second = protectAsyncRoutes(app);
    // Already wrapped, so the handler is no longer an AsyncFunction and is
    // not wrapped again -- re-running is safe.
    assert.equal(second.wrapped, 0);
  });

  test('it tolerates being handed something with no routes', () => {
    assert.deepEqual(protectAsyncRoutes(undefined), { wrapped: 0, skipped: 0 });
    assert.deepEqual(protectAsyncRoutes({}), { wrapped: 0, skipped: 0 });
  });
});
