// Base path regression: a server built with SCOTTY_BASE_PATH=/sub (default
// below) must serve the whole app under that prefix. Only the built-in demo
// project is read; the live-project checks use intercepted fixtures. Nothing
// is written.
// The variable is read by next.config.ts at build AND at `next start`:
//   SCOTTY_BASE_PATH=/sub npm run build
//   SCOTTY_BASE_PATH=/sub BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npx next start -p 3999 &
//   SCOTTY_TEST_URL=http://127.0.0.1:3999 node scripts/test-base-path.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { api, apiUrl, setApiRoot } from '../lib/api-client.ts';

// (a) lib/api-client.ts loads on its own in plain Node, with no Next build, and
// setApiRoot() moves every call under another prefix (issue #73). Default: "".
{
  const realFetch = globalThis.fetch;
  const called = [];
  globalThis.fetch = async url => { called.push(String(url)); return Response.json({}); };
  try {
    await api.projects.list();
    await api.list('p 1');
    assert.equal(api.attachments.urlFor('p', 'attachment://bd-1/shot.png'), '/api/p/p/attachments/bd-1/shot.png');
    setApiRoot('/api/tracker/');
    await api.projects.list();
    await api.list('p 1');
    await api.viewerMode();
    assert.equal(api.attachments.urlFor('p', 'attachment://bd-1/shot.png'), '/api/tracker/api/p/p/attachments/bd-1/shot.png');
    assert.equal(apiUrl('/api/p/p/beads/stream'), '/api/tracker/api/p/p/beads/stream');
    assert.deepEqual(called, ['/api/projects', '/api/p/p%201/beads', '/api/tracker/api/projects', '/api/tracker/api/p/p%201/beads', '/api/tracker/api/viewer-mode']);
  } finally {
    setApiRoot('');
    globalThis.fetch = realFetch;
  }
}

const base = process.env.SCOTTY_TEST_URL; assert.ok(base, 'Set SCOTTY_TEST_URL');
const prefix = process.env.SCOTTY_BASE_PATH || '/sub';
const origin = new URL(base).origin;
const outside = paths => paths.filter(p => p !== prefix && !p.startsWith(`${prefix}/`));

// (b) The unprefixed API does not exist: the app lives only under the prefix.
const bare = await fetch(`${origin}/api/projects`);
assert.equal(bare.status, 404, 'GET /api/projects without the prefix must be 404');
const prefixed = await fetch(`${origin}${prefix}/api/projects`);
assert.equal(prefixed.status, 200, 'GET <prefix>/api/projects must work');

// (c) The request guard (proxy.ts) covers everything under the prefix, the bare
// prefix (the launcher) included. A forged Host and a cross-site write are
// refused; the write carries an invalid body, so nothing could be written.
const send = (method, path, headers, body) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(origin);
  const req = http.request({ host: hostname, port, method, path, headers, setHost: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end(body);
});
for (const path of [prefix, `${prefix}/p/demo`, `${prefix}/api/projects`]) {
  assert.equal(await send('GET', path, { Host: 'rebind.evil.example' }), 403, `${path} with a rebound Host`);
}
assert.equal(await send('POST', `${prefix}/api/projects`, { Host: new URL(origin).host, Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, '{}'), 403, 'cross-site write under the prefix');

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.origin === origin) requests.push(u.pathname); });
  await page.addInitScript(() => {
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { copied.push(t); } } });
    window.__copied = copied;
  });

  // (d) The launcher renders at the prefix.
  await page.goto(`${origin}${prefix}`);
  await page.getByText('Demo', { exact: false }).first().waitFor();

  // (e) The Demo board loads cards under the prefix.
  await page.goto(`${origin}${prefix}/p/demo`);
  const card = page.locator('main [data-keyboard-bead-id]').first();
  await card.waitFor();
  assert.ok(await page.locator('main [data-keyboard-bead-id]').count() > 0, 'Demo board shows cards');

  // (f) The permalink copied from the drawer carries the prefix.
  await card.click();
  await page.getByTitle('Copy link', { exact: true }).click();
  await page.waitForFunction(() => window.__copied.length > 0);
  const copied = await page.evaluate(() => window.__copied[0]);
  assert.ok(copied.startsWith(`${origin}${prefix}/p/`), `permalink ${copied} must start with ${origin}${prefix}/p/`);

  // (g) Every same-origin request (pages, assets, icons, API, telemetry) stays under the prefix.
  assert.deepEqual(outside(requests), [], 'no request may leave the prefix');
  assert.ok(requests.some(p => p.startsWith(`${prefix}/_next/`)), 'assets load from the prefix');
  assert.ok(requests.some(p => p.startsWith(`${prefix}/api/p/demo/`)), 'project API is called under the prefix');
  assert.deepEqual(errors, []);

  // (h) A live project (intercepted): the live-update stream and the Needs You
  // attachment links use the prefix too. The demo project has neither.
  const live = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); live.setDefaultTimeout(10000);
  const liveErrors = [];
  live.on('pageerror', e => liveErrors.push(e.message));
  const liveRequests = [];
  live.on('request', r => { const u = new URL(r.url()); if (u.origin === origin) liveRequests.push(u.pathname); });
  const bead = { id: 'decision', title: 'Pick a layout', issue_type: 'task', status: 'open', priority: 1, labels: ['human'], dependencies: [],
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    description: 'See attachment://decision/screen.png and /api/p/fixture/attachments/decision/local.png' };
  await live.route('**/api/projects', route => route.fulfill({ json: { projects: [{ id: 'fixture', name: 'Fixture', path: null, hasBeads: true }] } }));
  await live.route('**/api/p/fixture/**', route => {
    assert.equal(route.request().method(), 'GET', 'base path checks never write');
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads: [bead], meta: { kind: 'demo', humanActor: 'reviewer', humanAllowlist: ['reviewer'], pollIntervalMs: 300000 } } });
    return route.fulfill({ json: {} });
  });
  await live.goto(`${origin}${prefix}/p/fixture`);
  await live.getByRole('button', { name: 'Needs You', exact: true }).click();
  await live.getByText('Links & attachments', { exact: true }).waitFor();
  const hrefs = await live.locator('[data-review-links] a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(hrefs.sort(), [`${prefix}/api/p/fixture/attachments/decision/local.png`, `${prefix}/api/p/fixture/attachments/decision/screen.png`]);
  assert.ok(liveRequests.includes(`${prefix}/api/p/fixture/beads/stream`), 'the SSE stream opens under the prefix');
  assert.deepEqual(outside(liveRequests), [], 'no request may leave the prefix');
  assert.deepEqual(liveErrors, []);
  console.log('PASS: api-client root, request guard, launcher, board, every request, permalink, live stream and Needs You links all live under the base path');
} finally { await browser.close(); }
