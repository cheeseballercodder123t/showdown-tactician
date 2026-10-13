/* Showdown Tactician — src/background.js
 * MV3 service worker. The only component that performs the optional LLM network request:
 * content scripts are subject to the page's CORS rules, so the decision is made here where
 * the extension's host permissions apply. Stores nothing; the API key travels in the
 * message payload and is never logged.
 */
'use strict';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const OPENROUTER_MODEL = 'google/gemini-2.0-flash-lite-001';
/* Fallback abort budget, used only when the caller sends none.
 *
 * This file must not own a second opinion about the budget. It used to hardcode 600 ms while
 * src/config.js said 600 ms too — and no hosted model answers in 600 ms, so the abort fired
 * before any provider could reply and every configured call failed. The budget now travels WITH
 * the request (src/llm_client.js sends `timeoutMs`, read from config.js, the single source of
 * truth); this literal is the safety net for a caller that sends nothing, and
 * tests/config_check.js asserts it matches config's `llm.timeoutMs` so the two cannot drift. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

function geminiRequest(cfg) {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: {
      systemInstruction: { parts: [{ text: cfg.system || '' }] },
      contents: [{ role: 'user', parts: [{ text: cfg.prompt || '' }] }],
      generationConfig: { maxOutputTokens: 80, temperature: 0.2 }
    },
    extract: function (json) {
      const cand = json && json.candidates && json.candidates[0];
      const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
      return part && typeof part.text === 'string' ? part.text : null;
    }
  };
}

function openRouterRequest(cfg) {
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: cfg.system || '' },
        { role: 'user', content: cfg.prompt || '' }
      ],
      max_tokens: 80,
      temperature: 0.2
    },
    extract: function (json) {
      const choice = json && json.choices && json.choices[0];
      return choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : null;
    }
  };
}

async function handleLLMRequest(payload) {
  const cfg = payload || {};
  if (!cfg.apiKey || typeof cfg.apiKey !== 'string') {
    return { ok: false, error: 'missing apiKey' };
  }
  if (!cfg.prompt || typeof cfg.prompt !== 'string') {
    return { ok: false, error: 'missing prompt' };
  }
  const spec = cfg.provider === 'openrouter' ? openRouterRequest(cfg) : geminiRequest(cfg);
  // The caller's budget when it sent one, otherwise the fallback above. Guarded, because a
  // message is untrusted input: a missing, zero, negative or non-finite value must fall back
  // rather than abort immediately (0 would kill every request) or never (Infinity).
  const budget = (typeof cfg.timeoutMs === 'number' && isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0)
    ? cfg.timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, budget);
  try {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Status only: the response body may echo request details.
      return { ok: false, error: 'provider status ' + res.status };
    }
    const json = await res.json();
    const text = spec.extract(json);
    if (!text) return { ok: false, error: 'empty completion' };
    return { ok: true, text: text };
  } catch (err) {
    clearTimeout(timer);
    const message = err && err.name === 'AbortError' ? 'timeout' : (err && err.message ? err.message : 'network error');
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'st-llm') return false;
  handleLLMRequest(message).then(sendResponse).catch(function (err) {
    sendResponse({ ok: false, error: err && err.message ? err.message : 'unknown error' });
  });
  return true;      // keep the message channel open for the async response
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details && details.reason === 'install') {
    chrome.storage.local.get({ provider: 'gemini', apiKey: '', teamText: '', elo: 1400 }, function (cfg) {
      chrome.storage.local.set(cfg);
    });
  }
});
