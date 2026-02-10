// OpenAI legacy Chat Completions client - Used by Nexnet
// Reads configuration from environment variables and optional runtime overrides:
// - LEGACYCLIENT_OPENAI_BASE_URL (fallback: OPENAI_BASE_URL)
// - LEGACYCLIENT_OPENAI_API_KEY (fallback: OPENAI_API_KEY)
// - LEGACYCLIENT_OPENAI_MODEL (fallback: OPENAI_MODEL) — can be overridden by runtime.config.js: { legacyModel }

import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

async function loadRuntimeOverrides() {
  try {
    const localCfgPath = path.resolve(process.cwd(), "llm-proxy", "runtime.config.js");
    const stat = await fs.stat(localCfgPath).catch(() => null);
    if (stat?.isFile()) {
      const mod = await import(pathToFileURL(localCfgPath).href);
      return mod?.default || mod?.config || {};
    }
    const jsonPath = path.resolve(process.cwd(), "llm-proxy", "runtime.config.json");
    const jstat = await fs.stat(jsonPath).catch(() => null);
    if (jstat?.isFile()) {
      const txt = await fs.readFile(jsonPath, "utf8");
      return JSON.parse(txt);
    }
  } catch {}
  return {};
}

const BASE_URL = process.env.LEGACYCLIENT_OPENAI_BASE_URL || "http://192.168.44.19:9000/v1";
const API_KEY = process.env.LEGACYCLIENT_OPENAI_API_KEY || "";
let MODEL = process.env.LEGACYCLIENT_OPENAI_MODEL || "devstral-small2-24b";

// Apply runtime override at module init
const __ovrPromise = loadRuntimeOverrides().then(ovr => {
  if (typeof ovr.legacyModel === "string" && ovr.legacyModel.trim()) {
    MODEL = ovr.legacyModel.trim();
    console.log("[legacy-openai] runtime model override:", MODEL);
  }
}).catch(() => {});

function toChatMessages(input) {
  return (Array.isArray(input) ? input : []).map(m => ({ role: m.role || 'user', content: String(m.content || '') }));
}

export async function sendRequest({ input }) {
  if (!API_KEY) {
    return { error: "LEGACYCLIENT_OPENAI_API_KEY missing", status: 500 };
  }
  try {
    await __ovrPromise; // ensure override applied before first request
    const endpoint = "/chat/completions";
    const url = `${BASE_URL}${endpoint}`;

    const messages = toChatMessages(input);
    console.log("[legacy-openai] POST", url, { model: MODEL, messagesCount: messages.length });

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error("[legacy-openai] HTTP", r.status, text.slice(0, 500));
      return { error: text, status: r.status };
    }
    const raw = JSON.parse(text);

    const content = raw?.choices?.[0]?.message?.content || "";
    const usage = raw?.usage || {};
    const data = {
      output_text: content,
      usage: {
        input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
        output_tokens: usage.completion_tokens || usage.output_tokens || 0,
        total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      },
      meta: { api: "chat-completions", model: MODEL, base_url: BASE_URL }
    };

    console.log("[legacy-openai] OK", { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens });
    return { data, status: r.status };
  } catch (e) {
    console.error("[legacy-openai] ERR", e);
    return { error: String(e), status: 500 };
  }
}
