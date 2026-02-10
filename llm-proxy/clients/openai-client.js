// OpenAI Responses API client
// Reads configuration from environment variables or optional runtime overrides.
// - OPENAI_BASE_URL (default: https://api.openai.com/v1)
// - OPENAI_API_KEY
// - OPENAI_MODEL (default: gpt-4.1-mini) — can be overridden by runtime.config.js: { openaiModel }

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

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY || "";
let MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Apply runtime override at module init
const __ovrPromise = loadRuntimeOverrides().then(ovr => {
  if (typeof ovr.openaiModel === "string" && ovr.openaiModel.trim()) {
    MODEL = ovr.openaiModel.trim();
    console.log("[openai] runtime model override:", MODEL);
  }
}).catch(() => {});

function toMessageArray(input) {
  return Array.isArray(input) ? input : [];
}

export async function sendRequest({ input }) {
  if (!API_KEY) {
    return { error: "OPENAI_API_KEY missing", status: 500 };
  }
  try {
    await __ovrPromise; // ensure override applied before first request
    const endpoint = "/responses";
    const url = `${BASE_URL}${endpoint}`;

    const messages = toMessageArray(input);
    console.log("[openai] POST", url, { model: MODEL, messagesCount: messages.length });

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: messages }),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error("[openai] HTTP", r.status, text.slice(0, 500));
      return { error: text, status: r.status };
    }
    const data = JSON.parse(text);

    const usage = data?.usage || {};
    console.log("[openai] OK", { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 });

    // Attach provider metadata
    data.meta = { api: "responses-api", model: MODEL, base_url: BASE_URL };

    return { data, status: r.status };
  } catch (e) {
    console.error("[openai] ERR", e);
    return { error: String(e), status: 500 };
  }
}
