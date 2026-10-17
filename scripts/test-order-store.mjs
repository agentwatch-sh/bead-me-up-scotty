// Manual order stored in beads metadata (the opt-in "beads" order store).
//
// Demo checks: start an isolated demo server with SCOTTY_ORDER_STORE=beads.
//   BEADS_DEMO=1 SCOTTY_ORDER_STORE=beads XDG_CONFIG_HOME=/tmp/scotty-order-test npm run start -- --port 3198
//   SCOTTY_TEST_URL=http://127.0.0.1:3198 node scripts/test-order-store.mjs
//
// Persistence check (the demo store is in-memory, so this needs a real bd repo):
// run against a server whose config registers a throwaway repo, restart the
// server between the two phases, and the order must survive.
//   SCOTTY_TEST_REPO=/path/to/throwaway-bd-repo SCOTTY_TEST_PHASE=write node scripts/test-order-store.mjs
//   (restart the server)
//   SCOTTY_TEST_REPO=/path/to/throwaway-bd-repo SCOTTY_TEST_PHASE=verify node scripts/test-order-store.mjs
import assert from "node:assert/strict";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated server");
const phase = process.env.SCOTTY_TEST_PHASE || "demo";
const repo = process.env.SCOTTY_TEST_REPO;
const RANK = "scotty.rank";

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data ?? json;
}
const beadsOf = async (pid) => (await call("GET", `/api/p/${pid}/beads`)).beads;
const orderOf = async (pid) => (await call("GET", `/api/p/${pid}/order`)).orders;
const putOrder = async (pid, columnId, ids) => (await call("PUT", `/api/p/${pid}/order`, { columnId, ids })).orders;
const setStore = (orderStore) => call("PUT", "/api/config", { orderStore });
const ranks = async (pid, ids) => {
  const all = await beadsOf(pid);
  return ids.map((id) => all.find((b) => b.id === id)?.metadata?.[RANK]);
};

if (phase === "demo") {
  const pid = "demo";
  assert.equal((await call("GET", `/api/p/${pid}/beads`)).meta.orderStore, "beads", "start the server with SCOTTY_ORDER_STORE=beads");

  // Three ready beads: open, no dependencies.
  const ready = (await beadsOf(pid)).filter((b) => b.status === "open" && !(b.dependencies ?? []).length).slice(0, 3);
  assert.equal(ready.length, 3, "demo data needs three unblocked open beads");
  const [a, b, c] = ready.map((x) => x.id);

  // Reorder: ranks are position x 1024, and the order API reads them back.
  const first = await putOrder(pid, "ready", [c, a, b]);
  assert.deepEqual(first.ready, [c, a, b]);
  assert.deepEqual(await ranks(pid, [c, a, b]), [0, 1024, 2048]);
  assert.deepEqual((await orderOf(pid)).ready, [c, a, b]);

  // Only beads whose rank changes are written.
  const stamp = async () => Object.fromEntries((await beadsOf(pid)).map((x) => [x.id, x.updated_at]));
  const before = await stamp();
  await new Promise((r) => setTimeout(r, 15));
  await putOrder(pid, "ready", [c, a, b]);
  assert.deepEqual(await stamp(), before, "an unchanged order must write nothing");
  await putOrder(pid, "ready", [c, b, a]);
  const after = await stamp();
  assert.equal(after[c], before[c], "an unmoved bead must not be rewritten");
  assert.notEqual(after[a], before[a]);
  assert.notEqual(after[b], before[b]);
  assert.deepEqual((await orderOf(pid)).ready, [c, b, a]);

  // Local backend: ranks stay put while the order lives in config.json.
  await setStore("local");
  assert.equal((await call("GET", `/api/p/${pid}/beads`)).meta.orderStore, "local");
  await putOrder(pid, "ready", [a, b, c]);
  assert.deepEqual((await orderOf(pid)).ready, [a, b, c]);
  assert.deepEqual(await ranks(pid, [c, b, a]), [0, 1024, 2048], "local mode must not touch metadata");

  // Switching back to beads copies the saved local order across, once.
  await setStore("beads");
  assert.deepEqual(await ranks(pid, [a, b, c]), [0, 1024, 2048], "the local order must migrate");
  assert.deepEqual((await orderOf(pid)).ready, [a, b, c]);
  const settled = await stamp();
  assert.deepEqual((await orderOf(pid)).ready, [a, b, c]);
  assert.deepEqual(await stamp(), settled, "reading must not rewrite");

  // Overlapping reorders: the final ranks match exactly one requested order.
  const orders = [[a, b, c], [c, b, a], [b, c, a], [a, c, b]];
  for (let round = 0; round < 3; round++) {
    await Promise.all(orders.map((ids) => putOrder(pid, "ready", ids)));
    const final = (await orderOf(pid)).ready;
    assert.ok(orders.some((ids) => JSON.stringify(ids) === JSON.stringify(final)), `overlapping PUTs left a mixed order: ${final}`);
    assert.deepEqual(await ranks(pid, final), [0, 1024, 2048], "ranks must be exactly position x 1024");
  }

  // A GET-triggered migration overlapping a PUT must not overwrite the newer order.
  for (let round = 0; round < 3; round++) {
    await setStore("local");
    await putOrder(pid, "ready", [a, b, c]);
    const newer = round % 2 ? [c, a, b] : [b, c, a];
    await Promise.all([
      setStore("beads"),
      orderOf(pid),
      putOrder(pid, "ready", newer),
      orderOf(pid),
    ]);
    assert.deepEqual((await orderOf(pid)).ready, newer, "a migration must not clobber a newer PUT");
    assert.deepEqual(await ranks(pid, newer), [0, 1024, 2048]);
  }

  // Unranked beads are not listed; the board puts them after ranked ones.
  const unranked = (await beadsOf(pid)).filter((x) => x.metadata?.[RANK] === undefined && x.status === "open" && !(x.dependencies ?? []).length);
  for (const u of unranked) assert.ok(!(await orderOf(pid)).ready.includes(u.id));
  console.log("order-store demo checks passed");
} else {
  assert.ok(repo, "Set SCOTTY_TEST_REPO to a throwaway bd repo");
  const pid = (await call("POST", "/api/projects", { path: repo })).id;
  assert.equal((await call("GET", `/api/p/${pid}/beads`)).meta.orderStore, "beads", "start the server with SCOTTY_ORDER_STORE=beads");
  const titles = ["order-a", "order-b", "order-c"];
  if (phase === "write") {
    const ids = [];
    for (const title of titles) ids.push((await call("POST", `/api/p/${pid}/beads`, { title, issue_type: "task", priority: 2 })).id);
    const [a, b, c] = ids;
    const orders = await putOrder(pid, "ready", [b, c, a]);
    assert.deepEqual(orders.ready, [b, c, a]);
    assert.deepEqual(await ranks(pid, [b, c, a]), [0, 1024, 2048]);
    console.log("order-store write phase passed; restart the server, then run the verify phase");
  } else {
    assert.equal(phase, "verify");
    const all = await beadsOf(pid);
    const [a, b, c] = titles.map((t) => all.find((x) => x.title === t)?.id);
    assert.ok(a && b && c, "run the write phase first");
    assert.deepEqual((await orderOf(pid)).ready, [b, c, a], "a fresh server must return the same order");
    console.log("order-store verify phase passed");
  }
}
