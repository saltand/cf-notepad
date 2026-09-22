#!/usr/bin/env node
/**
 * Smoke checks against a running wrangler dev server.
 * Usage: BASE=http://127.0.0.1:8787 node scripts/check.mjs
 */
const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const AUTO_ALPHABET = "abcdefghjkmnpqrstuvwxyz";
const AUTO_ID = new RegExp(`^[${AUTO_ALPHABET}]{6}$`);

async function main() {
  const root = await fetch(BASE + "/", { redirect: "manual" });
  assert(root.status === 302, `GET / expected 302, got ${root.status}`);
  const loc = root.headers.get("location");
  assert(loc, "GET / missing Location");
  const id = new URL(loc, BASE).pathname.slice(1);
  assert(AUTO_ID.test(id), `auto id "${id}" is not 6 letters from the 23-letter alphabet`);
  assert(!/[loi]/.test(id), `auto id "${id}" contains excluded letter`);

  const page = await fetch(BASE + "/" + id);
  assert(page.status === 200, `GET /${id} expected 200`);
  assert(page.headers.get("content-type")?.includes("text/html"), "editor should be HTML");
  const html = await page.text();
  assert(html.includes("<textarea"), "editor page missing textarea");
  assert(html.includes('href="/help"'), "editor should link to /help");
  assert(html.includes("How to use"), "en Accept-Language should use English help label");
  assert(html.includes('id="s"') && html.includes('class="sync"'), "editor should include sync-status icon");
  assert(html.includes('data-state="synced"'), "sync icon should start synced");
  assert(html.includes('aria-label="Synced"'), "en sync icon aria-label should be Synced");
  assert(html.includes("setTimeout(save, 800)"), "autosave debounce should remain ~800ms");
  const inputHandler = html.match(/el\.addEventListener\("input", \(\) => \{[\s\S]*?\}\);/);
  assert(inputHandler, "editor should bind an input autosave handler");
  assert(!inputHandler[0].includes("setState"), "typing/debounce must not change the sync icon");
  assert(!html.includes('if (!inflight) setState("unsynced")'), "input must not mark unsynced during debounce");
  assert(html.includes('if (!res.ok) throw new Error("save failed")'), "non-2xx PUT should fail the save");
  assert(html.includes('setState("unsynced")'), "failed PUT should mark unsynced");
  assert(html.includes("pointer-events:none"), "sync icon must not intercept typing");
  assert(html.includes("calc(1.6rem + .5rem)"), "sync icon should sit inside the textarea inset");
  await smokeSyncStateMachine(html);
  assert(!html.includes("After typing"), "preview-only caption must not ship in the editor");
  assert(!html.includes("<h1") && !html.includes("caption"), "editor must not add a visible caption/label");

  const pageZh = await fetch(BASE + "/" + id, { headers: { "accept-language": "zh-CN,zh;q=0.9" } });
  const htmlZh = await pageZh.text();
  assert(htmlZh.includes("如何使用"), "zh Accept-Language should use Chinese help label");
  assert(!htmlZh.includes("How to use"), "zh editor should not show English help label");
  assert(htmlZh.includes('aria-label="已同步"'), "zh sync icon aria-label should be 已同步");

  const help = await fetch(BASE + "/help");
  assert(help.status === 200, `GET /help expected 200, got ${help.status}`);
  assert(help.headers.get("content-type")?.includes("text/html"), "/help should be HTML");
  const helpHtml = await help.text();
  assert(helpHtml.includes("如何使用"), "/help missing Chinese section");
  assert(helpHtml.includes("How to use"), "/help missing English section");
  assert(helpHtml.includes("[a-z0-9_-]{1,64}"), "/help missing id pattern");
  assert(helpHtml.includes("NOTE_TTL_SECONDS"), "/help missing TTL var");
  assert(helpHtml.includes("?raw=1"), "/help missing raw query");
  assert(!helpHtml.includes('id="n"'), "/help must not be the editor");

  const helpRaw = await fetch(BASE + "/help?raw=1");
  assert(helpRaw.status === 200, "GET /help?raw=1 should still be the help page");
  assert((await helpRaw.text()).includes("<title>How to use"), "/help?raw=1 must not be a note");

  const helpPut = await fetch(BASE + "/help", { method: "PUT", body: "nope" });
  assert(helpPut.status === 405, `PUT /help expected 405, got ${helpPut.status}`);
  assert(html.includes('placeholder="Write something..."'), "default placeholder should be English");
  assert(html.includes('lang="en"'), "default html lang should be en");

  const zhPage = await fetch(BASE + "/" + id, {
    headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
  });
  const zhHtml = await zhPage.text();
  assert(zhHtml.includes('placeholder="写点什么..."'), "zh Accept-Language should use Chinese placeholder");
  assert(zhHtml.includes('lang="zh"'), "zh Accept-Language should set html lang=zh");

  const rawEmpty = await fetch(BASE + "/" + id + "?raw=1");
  assert(rawEmpty.headers.get("content-type")?.includes("text/plain"), "raw should be text/plain");
  assert((await rawEmpty.text()) === "", "new note should be empty");

  const put = await fetch(BASE + "/" + id, {
    method: "PUT",
    body: "hello notepad",
  });
  assert(put.status === 204, `PUT expected 204, got ${put.status}`);

  const raw = await fetch(BASE + "/" + id + "?raw=1");
  assert((await raw.text()) === "hello notepad", "PUT body not stored");

  const post = await fetch(BASE + "/curl-note", {
    method: "POST",
    body: "from post",
  });
  assert(post.status === 204, `POST expected 204, got ${post.status}`);
  const posted = await fetch(BASE + "/curl-note?raw=1");
  assert((await posted.text()) === "from post", "POST body not stored");

  const missingRaw = await fetch(BASE + "/never-written?raw=1");
  assert(missingRaw.status === 200 && (await missingRaw.text()) === "", "missing raw should be empty 200");

  const bad = await fetch(BASE + "/Has.Dots");
  assert(bad.status === 404, "invalid id should 404");

  const tooLong = "a".repeat(65);
  const long = await fetch(BASE + "/" + tooLong);
  assert(long.status === 404, "id over 64 should 404");

  const huge = await fetch(BASE + "/big", {
    method: "PUT",
    body: "x".repeat(1_048_577),
  });
  assert(huge.status === 413, `oversized body expected 413, got ${huge.status}`);

  const getStillOk = await fetch(BASE + "/" + id + "?raw=1");
  assert(getStillOk.status === 200, "GET must not be rate-limited");

  let limited = 0;
  let last429 = null;
  if (process.env.CHECK_RATE_LIMIT === "1") {
    for (let i = 0; i < 70; i++) {
      const r = await fetch(BASE + "/rl-check", { method: "PUT", body: "n" + i });
      if (r.status === 429) {
        limited++;
        last429 = r;
      } else {
        assert(r.status === 204, `burst PUT expected 204 or 429, got ${r.status}`);
      }
    }
    assert(limited > 0, "CHECK_RATE_LIMIT=1 expected at least one 429");
    assert(last429.headers.get("retry-after"), "429 missing Retry-After");
    assert((await last429.text()).length > 0, "429 should have a plain-text body");
  }

  console.log("ok", { autoId: id, rateLimit429: limited || "skipped (set CHECK_RATE_LIMIT=1)" });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Drive the inlined editor save machine with a mock fetch (no browser). */
async function smokeSyncStateMachine(html) {
  const match = html.match(/<script>\s*\(\(\) => \{([\s\S]*?)\}\)\(\);\s*<\/script>/);
  assert(match, "editor should ship an IIFE autosave script");
  const listeners = {};
  const icon = {
    dataset: { state: "synced" },
    setAttribute() {},
  };
  const el = {
    value: "draft",
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  const document = {
    getElementById(id) {
      return id === "n" ? el : icon;
    },
  };
  const location = { pathname: "/sync-smoke" };
  const pendingTimers = [];
  const setTimeoutMock = (fn) => {
    pendingTimers.push(fn);
    return pendingTimers.length;
  };
  const clearTimeoutMock = () => {
    pendingTimers.length = 0;
  };
  let fetchImpl = async () => ({ ok: true });
  const fetchMock = (...args) => fetchImpl(...args);
  const run = new Function("document", "location", "fetch", "setTimeout", "clearTimeout", match[1]);
  run(document, location, fetchMock, setTimeoutMock, clearTimeoutMock);

  assert(typeof listeners.input === "function", "input listener should be registered");
  listeners.input();
  assert(icon.dataset.state === "synced", "keystroke during debounce should stay synced");
  pendingTimers.pop()();
  assert(icon.dataset.state === "syncing", "save start should show syncing");
  await flush();
  assert(icon.dataset.state === "synced", "successful PUT should show synced");

  fetchImpl = async () => ({ ok: false, status: 413 });
  el.value = "x".repeat(1_048_577);
  listeners.input();
  assert(icon.dataset.state === "synced", "oversized draft should stay synced until PUT fails");
  pendingTimers.pop()();
  assert(icon.dataset.state === "syncing", "failed save still starts as syncing");
  await flush();
  assert(icon.dataset.state === "unsynced", "413 / non-2xx PUT should show unsynced");

  fetchImpl = async () => {
    throw new Error("network");
  };
  el.value = "retry";
  listeners.input();
  assert(icon.dataset.state === "unsynced", "after failure, stay unsynced while debounce waits");
  pendingTimers.pop()();
  await flush();
  assert(icon.dataset.state === "unsynced", "network error should show unsynced");

  fetchImpl = async () => ({ ok: true });
  el.value = "ok";
  listeners.input();
  pendingTimers.pop()();
  await flush();
  assert(icon.dataset.state === "synced", "later successful PUT should return to synced");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
