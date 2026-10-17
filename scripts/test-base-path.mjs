// Base path regression: a server built with SCOTTY_BASE_PATH=/sub (default
// below) must serve the whole app under that prefix. Only the built-in demo
// project is read; nothing is written.
// The variable is read by next.config.ts at build AND at `next start`:
//   SCOTTY_BASE_PATH=/sub npm run build
//   SCOTTY_BASE_PATH=/sub BEADS_DEMO=1 npx next start -p 3999 &
//   SCOTTY_TEST_URL=http://127.0.0.1:3999 node scripts/test-base-path.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL; assert.ok(base, 'Set SCOTTY_TEST_URL');
const prefix = process.env.SCOTTY_BASE_PATH || '/sub';
const origin = new URL(base).origin;

// (e) The unprefixed API does not exist: the app lives only under the prefix.
const bare = await fetch(`${origin}/api/projects`);
assert.equal(bare.status, 404, 'GET /api/projects without the prefix must be 404');
const prefixed = await fetch(`${origin}${prefix}/api/projects`);
assert.equal(prefixed.status, 200, 'GET <prefix>/api/projects must work');

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

  // (a) The launcher renders at the prefix.
  await page.goto(`${origin}${prefix}`);
  await page.getByText('Demo', { exact: false }).first().waitFor();

  // (c) The Demo board loads cards under the prefix.
  await page.goto(`${origin}${prefix}/p/demo`);
  const card = page.locator('main [data-keyboard-bead-id]').first();
  await card.waitFor();
  assert.ok(await page.locator('main [data-keyboard-bead-id]').count() > 0, 'Demo board shows cards');

  // (d) The permalink copied from the drawer carries the prefix.
  await card.click();
  await page.getByTitle('Copy link', { exact: true }).click();
  await page.waitForFunction(() => window.__copied.length > 0);
  const copied = await page.evaluate(() => window.__copied[0]);
  assert.ok(copied.startsWith(`${origin}${prefix}/p/`), `permalink ${copied} must start with ${origin}${prefix}/p/`);

  // (b) Every asset and API request stays under the prefix.
  const wanted = requests.filter(p => p.startsWith('/_next/') || p.startsWith('/api/'));
  assert.deepEqual(wanted, [], `unprefixed requests: ${wanted.join(', ')}`);
  const prefixedRequests = requests.filter(p => p.startsWith(`${prefix}/_next/`) || p.startsWith(`${prefix}/api/`));
  assert.ok(prefixedRequests.some(p => p.startsWith(`${prefix}/_next/`)), 'assets load from the prefix');
  assert.ok(prefixedRequests.some(p => p.startsWith(`${prefix}/api/p/demo/`)), 'project API is called under the prefix');
  assert.deepEqual(errors, []);
  console.log('PASS: launcher, board, API/asset requests and permalink all live under the base path');
} finally { await browser.close(); }
