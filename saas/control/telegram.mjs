import { createHash, randomBytes } from "node:crypto";

/**
 * One Telegram bot for the whole service.
 *
 * - A customer makes a one-time code in the portal and sends it to the bot.
 *   The code is stored hashed and expires in 15 minutes.
 * - Only one process polls Telegram (TELEGRAM_BOT_POLL=1, normally the mother).
 *   It hands each private message to the cell that owns the chat, so every cell
 *   can send alerts itself with the same token.
 * - The bot only reports and unlinks. It never trades or changes settings.
 */
export const TELEGRAM_CODE_TTL_MS = 15 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

export function newTelegramCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const normalizeTelegramCode = (text) => String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashTelegramCode = (code) => createHash("sha256").update(`telegram:${normalizeTelegramCode(code)}`).digest("hex");

export function createTelegram({ token = "", opsChatId = "", apiBase = "https://api.telegram.org", fetchImpl = globalThis.fetch, log = console } = {}) {
  const redact = (value) => String(value instanceof Error ? value.message : value).split(token).join("[token]");
  async function api(method, body, timeoutMs = 15_000) {
    const res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  }
  return {
    enabled: Boolean(token),
    async send(chatId, text) {
      if (!token || !chatId) return false;
      try {
        const r = await api("sendMessage", { chat_id: chatId, text: String(text).slice(0, 3500), disable_web_page_preview: true });
        return Boolean(r?.ok);
      } catch (err) {
        log.warn?.(`telegram send failed: ${redact(err)}`);
        return false;
      }
    },
    ops(text) {
      return opsChatId ? this.send(opsChatId, text) : Promise.resolve(false);
    },
    async updates(offset, waitSec = 25) {
      const r = await api("getUpdates", { offset, timeout: waitSec, allowed_updates: ["message"] }, (waitSec + 10) * 1000);
      if (!r?.ok) throw new Error(`getUpdates: ${redact(r?.description || "failed")}`);
      return r.result || [];
    },
  };
}

const HELP =
  "Commands:\n/status - your agent now\n/unlink - stop alerts in this chat\n/help - this message\n\nI only report. I never trade or change settings.";

/**
 * Runs on the cell that owns the tenant. `describe(row)` builds the /status text.
 * Returns { handled: false } when this cell has nothing to say, so the caller can try the next cell.
 */
export async function handleInbound({ store, config, now, chatId, text, describe }) {
  const body = String(text || "").trim();
  const start = body.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  const linkedHere = store.findByTelegramChat(chatId);
  const alreadyLinked = Boolean(linkedHere && linkedHere.host_id === config.hostId);
  // A bare 8-letter word is only a code from a chat that is not linked yet.
  const bare = !start && !body.startsWith("/") && !alreadyLinked && CODE_RE.test(normalizeTelegramCode(body));
  const code = start ? normalizeTelegramCode(start[1] || "") : bare ? normalizeTelegramCode(body) : "";

  if (code) {
    const row = CODE_RE.test(code) ? store.findByTelegramCodeHash(hashTelegramCode(code)) : null;
    if (!row || row.host_id !== config.hostId) {
      // A used or unknown code from a chat that is already linked here is not a stranger.
      return alreadyLinked
        ? { handled: true, reply: "This chat is already linked to your agent. Send /status, or /unlink if you want to link a different one." }
        : { handled: false };
    }
    if (Date.parse(row.telegram_code_expires || "") < now().getTime()) {
      return { handled: true, reply: "That code has expired. Make a new one in Settings and send it here." };
    }
    const taken = store.findByTelegramChat(chatId);
    if (taken && taken.id !== row.id) {
      return { handled: true, reply: "This chat is already linked to another agent. Send /unlink first, then use the new code." };
    }
    store.update(row.id, { telegram_chat_id: String(chatId), telegram_code_hash: null, telegram_code_expires: null, updated_at: now().toISOString() });
    return { handled: true, reply: `Linked. I will message you about trades, problems and your subscription.\n\n${HELP}` };
  }

  const row = linkedHere;
  if (!row || row.host_id !== config.hostId) return { handled: false };
  const cmd = body.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
  if (cmd === "/unlink") {
    store.update(row.id, { telegram_chat_id: null, updated_at: now().toISOString() });
    return { handled: true, reply: "Unlinked. You will not get alerts here any more." };
  }
  if (cmd === "/status") return { handled: true, reply: await describe(row) };
  return { handled: true, reply: HELP };
}

export const NOT_LINKED_REPLY =
  "I do not know this chat yet. Open Settings in your Neural Alpha portal, press Link Telegram, then send me the code.";

/** Long-polls Telegram and routes each private message. `route` returns the reply text. */
export function startPolling({ telegram, route, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let stopped = false;
  let offset = 0;
  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const list = await telegram.updates(offset);
        failures = 0;
        for (const u of list) {
          offset = Math.max(offset, u.update_id + 1);
          const m = u.message;
          // Private chats only: a group would leak a customer's alerts to everyone in it.
          if (!m?.text || m.chat?.type !== "private") continue;
          const reply = await route({ chatId: String(m.chat.id), username: m.from?.username || "", text: m.text });
          if (reply) await telegram.send(m.chat.id, reply);
        }
      } catch (err) {
        failures += 1;
        log.warn?.(`telegram poll: ${err instanceof Error ? err.message : err}`);
        await sleep(Math.min(60_000, 2000 * failures));
      }
    }
  })();
  return { stop: () => { stopped = true; return loop; } };
}
