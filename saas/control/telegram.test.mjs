import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "./store.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegram, handleInbound, hashTelegramCode, newTelegramCode, startPolling, TELEGRAM_CODE_TTL_MS } from "./telegram.mjs";

const NOW = new Date("2026-11-01T00:00:00Z");
const config = { hostId: "cell-1" };
function seed() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "na-tg-")), "c.sqlite"));
  for (const id of ["aaaa1111", "bbbb2222"]) {
    store.insert({ id, host_id: "cell-1", status: "running", container_name: `na-${id}`, data_dir: `/x/${id}`, risk_preset: "100", agent_mode: "paper",
      max_position_usd: 100, max_drawdown_pct: 0, max_trade_usd: 100, trade_interval_ms: 1, created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
  }
  return store;
}
const arm = (store, id, code, ttl = TELEGRAM_CODE_TTL_MS) =>
  store.update(id, { telegram_code_hash: hashTelegramCode(code), telegram_code_expires: new Date(NOW.getTime() + ttl).toISOString() });
const ask = (store, chatId, text) => handleInbound({ store, config, now: () => NOW, chatId, text, describe: async (r) => `status for ${r.id}` });

test("codes are 8 safe characters and hashed with a stable result", () => {
  const code = newTelegramCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(hashTelegramCode(code), hashTelegramCode(code.toLowerCase()));
  assert.notEqual(hashTelegramCode(code), hashTelegramCode("AAAAAAAA"));
});

test("/start CODE and a bare code both link, and the code works once", async () => {
  const store = seed();
  arm(store, "aaaa1111", "K7M2QX9P");
  const r = await ask(store, "555", "/start K7M2QX9P");
  assert.equal(r.handled, true);
  assert.match(r.reply, /^Linked/);
  assert.equal(store.get("aaaa1111").telegram_chat_id, "555");
  assert.equal(store.get("aaaa1111").telegram_code_hash, null);
  assert.deepEqual(await ask(store, "777", "/start K7M2QX9P"), { handled: false });
  arm(store, "bbbb2222", "ZZZ22222");
  assert.match((await ask(store, "888", "zzz22222")).reply, /^Linked/);
});

test("expired codes and a chat that is already linked are refused", async () => {
  const store = seed();
  arm(store, "aaaa1111", "K7M2QX9P", -1000);
  assert.match((await ask(store, "555", "/start K7M2QX9P")).reply, /expired/);
  assert.equal(store.get("aaaa1111").telegram_chat_id, null);
  arm(store, "aaaa1111", "K7M2QX9P");
  await ask(store, "555", "/start K7M2QX9P");
  arm(store, "bbbb2222", "ZZZ22222");
  assert.match((await ask(store, "555", "/start ZZZ22222")).reply, /already linked/);
  assert.equal(store.get("bbbb2222").telegram_chat_id, null);
});

test("a code for another host is not handled here, so the caller tries the next cell", async () => {
  const store = seed();
  store.update("aaaa1111", { host_id: "cell-2" });
  arm(store, "aaaa1111", "K7M2QX9P");
  assert.deepEqual(await ask(store, "555", "/start K7M2QX9P"), { handled: false });
});

test("linked chats get /status, /help and /unlink; unknown chats are not handled", async () => {
  const store = seed();
  arm(store, "aaaa1111", "K7M2QX9P");
  await ask(store, "555", "/start K7M2QX9P");
  assert.equal((await ask(store, "555", "/status")).reply, "status for aaaa1111");
  assert.match((await ask(store, "555", "whatever")).reply, /never trade/);
  assert.deepEqual(await ask(store, "999", "/status"), { handled: false });
  assert.match((await ask(store, "555", "/unlink")).reply, /Unlinked/);
  assert.equal(store.get("aaaa1111").telegram_chat_id, null);
});

test("send never leaks the token and reports failure", async () => {
  const logs = [];
  const tg = createTelegram({
    token: "123:SECRET",
    fetchImpl: async () => { throw new Error("connect to https://api.telegram.org/bot123:SECRET/sendMessage failed"); },
    log: { warn: (m) => logs.push(m) },
  });
  assert.equal(await tg.send("1", "hi"), false);
  assert.ok(logs[0] && !logs[0].includes("SECRET"));
  assert.equal(createTelegram({}).enabled, false);
  assert.equal(await createTelegram({}).send("1", "hi"), false);
});

test("the poller answers private chats only and advances its offset", async () => {
  const sent = [];
  let call = 0;
  const batches = [
    [
      { update_id: 10, message: { text: "/status", chat: { id: 1, type: "private" }, from: {} } },
      { update_id: 11, message: { text: "/status", chat: { id: 2, type: "group" }, from: {} } },
    ],
  ];
  let poller;
  const telegram = {
    async updates(offset) {
      call += 1;
      if (call === 1) { assert.equal(offset, 0); return batches[0]; }
      assert.equal(offset, 12);
      poller.stop();
      return [];
    },
    async send(chat, text) { sent.push([chat, text]); },
  };
  poller = startPolling({ telegram, route: async ({ chatId }) => `hi ${chatId}`, sleep: async () => {} });
  await poller.stop();
  assert.deepEqual(sent, [[1, "hi 1"]]);
});
