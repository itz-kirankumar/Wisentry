import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_DEMO_MODE = "true";

let GET, stateGET, keysGET, prefsGET, prospectingGET;
before(async () => {
  GET = (await import("../src/app/api/app-shell/route.ts")).GET;
  stateGET = (await import("../src/app/api/geo/state/route.ts")).GET;
  keysGET = (await import("../src/app/api/geo/keys/route.ts")).GET;
  prefsGET = (await import("../src/app/api/geo/ui-prefs/route.ts")).GET;
  prospectingGET = (await import("../src/app/api/prospecting/route.ts")).GET;
});

function getReq(auth = true) {
  return new Request("https://test.local/api/app-shell", {
    headers: auth ? { authorization: "Bearer demo-token" } : {},
  });
}

test("unauthenticated requests are rejected with 401", async () => {
  const res = await GET(getReq(false));
  assert.equal(res.status, 401);
});

test("no-store cache header is set", async () => {
  const res = await GET(getReq());
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("returns all four sections for the demo workspace", async () => {
  const res = await GET(getReq());
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.ok(payload.sections, "sections wrapper present");
  for (const name of ["state", "uiPrefs", "keys", "prospecting"]) {
    assert.ok(payload.sections[name], `section ${name} present`);
    assert.equal(payload.sections[name].error, undefined, `section ${name} has no error`);
  }
});

test("state section matches the standalone /api/geo/state payload", async () => {
  const [batchRes, soloRes] = await Promise.all([GET(getReq()), stateGET(getReq())]);
  const batch = (await batchRes.json()).sections.state;
  const solo = await soloRes.json();
  assert.deepEqual(batch, solo);
});

test("keys section matches the standalone /api/geo/keys payload", async () => {
  const [batchRes, soloRes] = await Promise.all([GET(getReq()), keysGET(getReq())]);
  const batch = (await batchRes.json()).sections.keys;
  const solo = await soloRes.json();
  assert.deepEqual(batch, solo);
});

test("uiPrefs section matches the standalone /api/geo/ui-prefs payload", async () => {
  const [batchRes, soloRes] = await Promise.all([GET(getReq()), prefsGET(getReq())]);
  const batch = (await batchRes.json()).sections.uiPrefs;
  const solo = await soloRes.json();
  assert.deepEqual(batch, solo);
});

test("prospecting section matches the standalone /api/prospecting payload", async () => {
  const [batchRes, soloRes] = await Promise.all([GET(getReq()), prospectingGET(getReq())]);
  const batch = (await batchRes.json()).sections.prospecting;
  const solo = await soloRes.json();
  assert.deepEqual(batch, solo);
});

function badReq() {
  return new Request("https://test.local/api/app-shell", {
    headers: { authorization: "Bearer not-a-real-firebase-token" },
  });
}

test("malformed token is rejected with the same status as every standalone route", async () => {
  const [batch, state, keys, prefs, prospecting] = await Promise.all([
    GET(badReq()),
    stateGET(badReq()),
    keysGET(badReq()),
    prefsGET(badReq()),
    prospectingGET(badReq()),
  ]);
  assert.ok(batch.status === 401 || batch.status === 403, `batch rejects malformed token, got ${batch.status}`);
  assert.equal(batch.status, state.status);
  assert.equal(batch.status, keys.status);
  assert.equal(batch.status, prefs.status);
  assert.equal(batch.status, prospecting.status);
});

test("demo-token restrictions hold: no cron ops data, fixed dark theme", async () => {
  const res = await GET(getReq());
  const { sections } = await res.json();
  assert.equal(sections.state.lastCron, null, "demo workspace never exposes admin cron data");
  assert.deepEqual(sections.uiPrefs, { theme: "dark" }, "demo theme is the fixed dark default");
});

test("key sections carry only the masked status shape - no secret material", async () => {
  const res = await GET(getReq());
  const { sections } = await res.json();
  for (const list of [sections.keys.providers, sections.state.providers]) {
    for (const provider of list) {
      for (const field of Object.keys(provider)) {
        assert.ok(
          ["id", "label", "kind", "source", "lastFour", "custom", "baseUrl", "model"].includes(field),
          `unexpected field ${field} in provider status`
        );
      }
    }
  }
  const serialized = JSON.stringify(sections);
  assert.ok(!/sk-[A-Za-z0-9]|AIza[0-9A-Za-z_-]/i.test(serialized), "no API-key-shaped strings in any section");
});
