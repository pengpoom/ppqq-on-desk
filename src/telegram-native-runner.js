"use strict";

// Bridges TelegramNativeClient (raw API primitives) and the owner-manager's
// expected handle shape:
//   { isPolling(), start(), stop(), sendTestCard(payload) }
//
// Responsibilities the client itself does NOT handle:
//   - long-poll loop with 409 retry on first iteration
//   - test-card lifecycle: build a nonce, sendMessage with inline keyboard,
//     watch incoming callback_queries for matching nonce + allowed user
//   - real approval lifecycle: requestApproval(payload, { signal }) Promise
//     that resolves a typed allow/deny/suggestion decision on a matching
//     Telegram callback, or null on abort/timeout/send failure
//   - dispatch TEST_SUCCESS / TEST_FAILED back to the migration controller

const {
  TelegramNativeClient,
  pollWithConflictRetry,
  classifyError,
  ERROR_CLASSES,
} = require("./telegram-native-client");

const { EVENTS } = require("./telegram-migration-state");

const APPROVAL_CALLBACK_RE = /^cp:([a-z0-9]+):(a|d|s(\d+))$/;
const LEGACY_APPROVAL_CALLBACK_RE = /^clawdperm:([a-z0-9]+):(allow|deny)$/;
const MAX_MESSAGE_TEXT = 3800;
const MAX_BUTTON_TEXT = 32;
const DEFAULT_APPROVAL_TIMEOUT_MS = 90000;
// R1a notifications are fire-and-forget: a slow send must not pile up behind
// the snapshot fanout that triggers it. Bound each send and drop on timeout.
const DEFAULT_NOTIFY_TIMEOUT_MS = 10000;
// Telegram 429s carry retry_after (seconds). Retry once, but never park a
// notification longer than this — a stale "done" ping is worthless.
const MAX_NOTIFY_RETRY_DELAY_MS = 30000;

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

function compactMessageText(value, maxLen = MAX_MESSAGE_TEXT) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  return text;
}

function buildApprovalText(payload) {
  const title = compactMessageText(payload && payload.title, 240);
  if (!title) return null;
  const detail = compactMessageText(payload && payload.detail, MAX_MESSAGE_TEXT - title.length - 32);
  return detail ? `${title}\n\n${detail}` : title;
}

function normalizeApprovalSuggestions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const suggestions = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const index = Number(item.index);
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    const label = compactMessageText(item.label, MAX_BUTTON_TEXT);
    if (!label) continue;
    seen.add(index);
    suggestions.push({ index, label });
  }
  return suggestions;
}

function parseApprovalCallbackData(data) {
  if (typeof data !== "string") return null;
  const match = data.match(APPROVAL_CALLBACK_RE);
  if (match) {
    const actionCode = match[2];
    if (actionCode === "a") return { id: match[1], decision: { action: "allow" } };
    if (actionCode === "d") return { id: match[1], decision: { action: "deny" } };
    const index = Number(match[3]);
    if (Number.isInteger(index) && index >= 0) {
      return { id: match[1], decision: { action: "suggestion", index } };
    }
    return null;
  }
  const legacyMatch = data.match(LEGACY_APPROVAL_CALLBACK_RE);
  if (!legacyMatch) return null;
  return { id: legacyMatch[1], decision: { action: legacyMatch[2] } };
}

function normalizeApprovalDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  if (decision.action === "allow" || decision.action === "deny") {
    return { action: decision.action };
  }
  if (decision.action === "suggestion") {
    const index = Number(decision.index);
    return Number.isInteger(index) && index >= 0 ? { action: "suggestion", index } : null;
  }
  return null;
}

function createTelegramNativeRunner({
  tokenStore,
  transport,
  getDispatch,        // () => migrationController.dispatch (lazy for cycle)
  getChatId,          // () => "<chat id>" (number-string)
  getAllowedUserId,   // () => "<user id>"
  log = () => {},
  longPollTimeoutMs = 25, // Telegram seconds
  approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  notifyTimeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
  // Injectable so tests can drive 429 retry without real timers.
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }),
}) {
  const client = new TelegramNativeClient({ tokenStore, transport });

  let abortController = null;
  let polling = false;
  let pendingTest = null; // { nonce, chatId, allowedUser, messageId }
  const pendingApprovals = new Map(); // id -> { resolve, chatId, allowedUser, messageId, timer, signal, onAbort, suggestionIndexes }

  function isPolling() {
    return polling;
  }

  function isEnabled() {
    return polling && !!getChatId();
  }

  async function start() {
    if (polling) return;
    polling = true;
    const controller = new AbortController();
    abortController = controller;
    // First poll uses retry to absorb 409 from a still-releasing sidecar.
    loopFirst(controller.signal).catch((err) => {
      log("warn", "native polling stopped", { error: err && err.message });
    }).finally(() => {
      if (abortController === controller) {
        polling = false;
        abortController = null;
      }
    });
  }

  async function stop() {
    polling = false;
    if (abortController) {
      try { abortController.abort(); } catch {}
      abortController = null;
    }
    clearAllApprovals();
  }

  async function loopFirst(signal) {
    try {
      await pollWithConflictRetry(() => client.getUpdates({ timeout: 0, signal }), { signal });
    } catch (err) {
      const cls = classifyError(err);
      if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
      if (cls === ERROR_CLASSES.CONFLICT || cls === ERROR_CLASSES.WEBHOOK_CONFLICT) {
        await failTest(err, cls);
        return;
      }
      // Any other class: pass through to normal loop so consistent classification.
      await failTest(err, cls);
      return;
    }
    return loop(signal);
  }

  async function loop(signal) {
    while (polling && !signal.aborted) {
      let updates;
      try {
        updates = await client.getUpdates({ timeout: longPollTimeoutMs, signal });
      } catch (err) {
        const cls = classifyError(err);
        if (cls === ERROR_CLASSES.TIMEOUT) return; // aborted
        await failTest(err, cls);
        return;
      }
      for (const u of updates) {
        await handleUpdate(u);
      }
    }
  }

  async function handleUpdate(update) {
    if (!update || !update.callback_query) return;
    const cb = update.callback_query;
    const fromId = cb.from && String(cb.from.id);
    const chatId = cb.message && cb.message.chat && String(cb.message.chat.id);

    if (pendingTest) {
      const handledTest = await handleTestCallback(cb, { fromId, chatId });
      if (handledTest) return;
    }

    const handledApproval = await handleApprovalCallback(cb, { fromId, chatId });
    if (!handledApproval) return;
  }

  async function handleTestCallback(cb, { fromId, chatId }) {
    const isAllowedUser = !pendingTest.allowedUser || fromId === String(pendingTest.allowedUser);
    const isExpectedChat = !pendingTest.chatId || chatId === String(pendingTest.chatId);
    if (cb.data !== `clawd-test:${pendingTest.nonce}` || !isAllowedUser || !isExpectedChat) {
      if (typeof cb.data !== "string" || !cb.data.startsWith("clawd-test:")) return false;
      // Acknowledge stray callbacks so the Telegram client closes its spinner.
      try { await client.answerCallbackQuery({ callback_query_id: cb.id }); } catch {}
      return true;
    }
    try { await client.answerCallbackQuery({ callback_query_id: cb.id, text: "OK" }); } catch {}
    try {
      await client.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: pendingTest.messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {}
    pendingTest = null;
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch({ type: EVENTS.TEST_SUCCESS, at: Date.now() });
    return true;
  }

  async function handleApprovalCallback(cb, { fromId, chatId }) {
    const data = typeof cb.data === "string" ? cb.data : "";
    const parsed = parseApprovalCallbackData(data);
    if (!parsed) return false;
    const entry = pendingApprovals.get(parsed.id);
    if (!entry) {
      try { await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Expired" }); } catch {}
      return true;
    }
    const isAllowedUser = !entry.allowedUser || fromId === String(entry.allowedUser);
    const isExpectedChat = !entry.chatId || chatId === String(entry.chatId);
    if (!isAllowedUser || !isExpectedChat) {
      try { await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Not allowed" }); } catch {}
      return true;
    }

    const decision = parsed.decision;
    if (decision.action === "suggestion" && !entry.suggestionIndexes.has(decision.index)) {
      try { await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Unavailable" }); } catch {}
      return true;
    }
    try {
      await client.answerCallbackQuery({
        callback_query_id: cb.id,
        text: decision.action === "allow" ? "Allowed" : (decision.action === "deny" ? "Denied" : "Applied"),
      });
    } catch {}
    try {
      await client.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: entry.messageId || (cb.message && cb.message.message_id),
        reply_markup: { inline_keyboard: [] },
      });
    } catch {}
    finishApproval(parsed.id, decision);
    return true;
  }

  async function dispatchEvent(event) {
    const dispatch = getDispatch && getDispatch();
    if (dispatch) await dispatch(event);
  }

  function dispatchEventSoon(event) {
    const timer = setTimeout(() => {
      dispatchEvent(event).catch((err) => {
        log("warn", "native dispatch failed", { error: err && err.message });
      });
    }, 0);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function failTest(err, errorClass, { defer = false } = {}) {
    pendingTest = null;
    const event = {
      type: EVENTS.TEST_FAILED,
      errorClass,
      description: err && err.description,
    };
    if (defer) dispatchEventSoon(event);
    else await dispatchEvent(event);
  }

  async function sendTestCard() {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    if (!chatId) {
      dispatchEventSoon({ type: EVENTS.TEST_FAILED, errorClass: "no_chat" });
      return;
    }
    const nonce = randomId();
    try {
      const msg = await client.sendMessage({
        chat_id: chatId,
        text: "Clawd: test native Telegram bot. Tap to confirm.",
        reply_markup: {
          inline_keyboard: [[{ text: "Confirm", callback_data: `clawd-test:${nonce}` }]],
        },
      });
      pendingTest = {
        nonce,
        chatId,
        allowedUser,
        messageId: msg && msg.message_id,
      };
    } catch (err) {
      await failTest(err, classifyError(err), { defer: true });
    }
  }

  function finishApproval(id, decision) {
    const entry = pendingApprovals.get(id);
    if (!entry) return;
    pendingApprovals.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch {}
    }
    entry.resolve(normalizeApprovalDecision(decision));
  }

  function clearAllApprovals() {
    const ids = Array.from(pendingApprovals.keys());
    for (const id of ids) finishApproval(id, null);
  }

  function requestApproval(payload, options = {}) {
    const chatId = getChatId();
    const allowedUser = getAllowedUserId();
    const text = buildApprovalText(payload);
    const suggestions = normalizeApprovalSuggestions(payload && payload.suggestions);
    const signal = options && options.signal;
    if (!polling || !chatId || !text || (signal && signal.aborted)) {
      const reason = !polling ? "not polling"
        : (!chatId ? "missing chat" : (!text ? "missing text" : "aborted"));
      log("debug", `native approval skipped: ${reason}`);
      return Promise.resolve(null);
    }
    const id = randomId();
    const callbackBase = `cp:${id}`;
    const inlineKeyboard = [[
      { text: "Allow once", callback_data: `${callbackBase}:a` },
      { text: "Deny", callback_data: `${callbackBase}:d` },
    ]];
    for (const suggestion of suggestions) {
      inlineKeyboard.push([
        { text: suggestion.label, callback_data: `${callbackBase}:s${suggestion.index}` },
      ]);
    }
    return new Promise((resolve) => {
      const entry = {
        resolve,
        chatId,
        allowedUser,
        messageId: null,
        timer: null,
        signal,
        onAbort: null,
        suggestionIndexes: new Set(suggestions.map((suggestion) => suggestion.index)),
      };
      pendingApprovals.set(id, entry);

      entry.timer = setTimeout(() => finishApproval(id, null), Math.max(1, approvalTimeoutMs));
      if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();

      if (signal) {
        entry.onAbort = () => finishApproval(id, null);
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      client.sendMessage({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }).then((msg) => {
        const current = pendingApprovals.get(id);
        if (current) current.messageId = msg && msg.message_id;
        log("debug", "native approval card sent");
      }).catch((err) => {
        log("warn", "native approval send failed", { error: err && err.message });
        finishApproval(id, null);
      });
    });
  }

  // Send one plain-text message with a bounded timeout. No inline keyboard,
  // no pending lifecycle — this is the building block for fire-and-forget
  // notifications (R1a). Returns the raw message or throws a classified error.
  // The injected logger ultimately does a synchronous file write
  // (telegramApprovalLog → permLog → rotatedAppend), which can throw on a
  // bad path / EACCES. Notifications are fire-and-forget on an async chain, so
  // a throwing log must not turn into an unhandled rejection.
  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  async function sendBoundedMessage(chatId, text) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, Math.max(1, notifyTimeoutMs));
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      return await client.sendMessage(
        { chat_id: chatId, text },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Public R1a entry point. Best-effort: never throws, always resolves to a
  // structured result so callers (the snapshot fanout) can log without
  // branching on exceptions. One 429 retry honouring retry_after; everything
  // else (403 blocked, timeout, network) is logged and dropped.
  async function sendNotification(text) {
    const chatId = getChatId();
    const body = compactMessageText(text);
    if (!polling || !chatId || !body) {
      return { ok: false, errorClass: "not_active" };
    }
    try {
      await sendBoundedMessage(chatId, body);
      return { ok: true };
    } catch (err) {
      const cls = classifyError(err);
      if (cls === ERROR_CLASSES.RATE_LIMITED) {
        const retryAfter = Number(err && err.parameters && err.parameters.retry_after);
        const delayMs = Math.min(
          MAX_NOTIFY_RETRY_DELAY_MS,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
        );
        safeLog("warn", "native notification rate limited, retrying once", { delayMs });
        try {
          await sleep(delayMs);
          // Re-read chat id: the user may have re-targeted Telegram during the
          // retry_after window. Bail if polling stopped, the chat was cleared,
          // OR the target changed — re-firing a "done" ping at a different chat
          // than the one in flight is worse than dropping it.
          const retryChatId = getChatId();
          if (!polling || !retryChatId || retryChatId !== chatId) {
            return { ok: false, errorClass: "not_active" };
          }
          await sendBoundedMessage(retryChatId, body);
          return { ok: true };
        } catch (err2) {
          const cls2 = classifyError(err2);
          safeLog("warn", "native notification send failed", { errorClass: cls2 });
          return { ok: false, errorClass: cls2 };
        }
      }
      if (cls === ERROR_CLASSES.TOKEN_MISSING) {
        safeLog("debug", "native notification skipped: no token");
      } else {
        safeLog("warn", "native notification send failed", { errorClass: cls });
      }
      return { ok: false, errorClass: cls };
    }
  }

  return {
    isEnabled,
    isPolling,
    start,
    stop,
    sendTestCard,
    requestApproval,
    sendNotification,
    _client: client,
    _pendingApprovals: pendingApprovals,
  };
}

module.exports = {
  createTelegramNativeRunner,
  buildApprovalText,
};
