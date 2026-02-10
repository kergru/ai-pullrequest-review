import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sendRequest as sendPrimary } from "./clients/openai-client.js";
import { sendRequest as sendLegacy } from "./clients/openai-legacy-client.js";

// Define runtimeConfig before usage in overrides loader
const runtimeConfig = {
  legacyEnabled: String(process.env.LEGACYCLIENT_ENABLED || "false").toLowerCase() === "true",
  maxDiffChars: Number.parseInt(process.env.MAX_DIFF_CHARS || "120000", 10),
};

// Try to load local overrides once at startup (POC-friendly; edit file and restart)
try {
  const localCfgPath = path.resolve(process.cwd(), "llm-proxy", "runtime.config.js");
  const stat = await fs.stat(localCfgPath).catch(() => null);
  if (stat && stat.isFile()) {
    const mod = await import(pathToFileURL(localCfgPath).href);
    const overrides = mod?.default || mod?.config || {};
    if (typeof overrides.legacyEnabled === "boolean") runtimeConfig.legacyEnabled = overrides.legacyEnabled;
    if (typeof overrides.maxDiffChars === "number" && Number.isFinite(overrides.maxDiffChars) && overrides.maxDiffChars > 0) {
      runtimeConfig.maxDiffChars = Math.min(Math.floor(overrides.maxDiffChars), 1_000_000);
    }
    console.log("[runtime] overrides loaded from", localCfgPath, runtimeConfig);
  } else {
    // Also support plain JSON file as fallback
    const jsonPath = path.resolve(process.cwd(), "llm-proxy", "runtime.config.json");
    const jstat = await fs.stat(jsonPath).catch(() => null);
    if (jstat && jstat.isFile()) {
      const txt = await fs.readFile(jsonPath, "utf8");
      const overrides = JSON.parse(txt);
      if (typeof overrides.legacyEnabled === "boolean") runtimeConfig.legacyEnabled = overrides.legacyEnabled;
      if (typeof overrides.maxDiffChars === "number" && Number.isFinite(overrides.maxDiffChars) && overrides.maxDiffChars > 0) {
        runtimeConfig.maxDiffChars = Math.min(Math.floor(overrides.maxDiffChars), 1_000_000);
      }
      console.log("[runtime] overrides loaded from", jsonPath, runtimeConfig);
    }
  }
} catch (e) {
  console.warn("[runtime] override load failed:", e);
}

const app = express();
app.use(express.json({ limit: "5mb" }));

const PROMPTS_DIR = process.env.PROMPTS_DIR || path.resolve(process.cwd(), "prompts");

// Simple in-memory cache for prompt files
const promptCache = new Map();

async function loadPromptFile(filename) {
    const full = path.join(PROMPTS_DIR, filename);
    if (promptCache.has(full)) return promptCache.get(full);

    const content = await fs.readFile(full, "utf8");
    // Normalize line endings, trim only trailing whitespace
    const normalized = content.replaceAll(/\r\n/g, "\n").trimEnd();
    promptCache.set(full, normalized);
    return normalized;
}

async function getSystemPrompt(task) {
    // Map tasks to files
    if (!task || task === "code_review") return loadPromptFile("code_review.system.txt");
    if (task === "jira_alignment") return loadPromptFile("jira_alignment.system.txt");
    return loadPromptFile("default.system.txt");
}

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

function safeSliceDiff(diff) {
    return String(diff || "").slice(0, runtimeConfig.maxDiffChars);
}

function extractOutputText(data) {
    if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;

    // Fallback: responses output array
    const out = data?.output;
    if (Array.isArray(out)) {
        let acc = "";
        for (const item of out) {
            const content = item?.content;
            if (!Array.isArray(content)) continue;
            for (const c of content) {
                if (c?.type === "output_text" && typeof c?.text === "string") acc += c.text;
                if (c?.type === "text" && typeof c?.text === "string") acc += c.text;
            }
        }
        if (acc.trim()) return acc;
    }
    return "";
}

function appendProviderFooter(text, meta) {
    try {
        const api = meta?.api || "unknown-api";
        const model = meta?.model || "unknown-model";
        return `${text}\n\n---\nProvider: ${api} | Model: ${model}`;
    } catch {
        return text;
    }
}

/**
 * Token-lean message construction:
 * - Avoid verbose labels like "Rules:" / "Diff:".
 * - Keep structure minimal but unambiguous.
 * - Put diff last to maximize relevance.
 */
async function buildMessagesForPayload(body) {
    const { task, diff, rules, jira, pull_request, instructions } = body || {};
    const systemPrompt = await getSystemPrompt(task);
    const safeDiff = safeSliceDiff(diff);

    // Backwards compatible: old client sends only {diff, rules}
    if (!task || task === "code_review") {
        const rulesText = (rules || "").trim();
        const content =
            (rulesText ? `${rulesText}\n\n` : "") +
            `${safeDiff}`;

        return [
            { role: "system", content: systemPrompt },
            { role: "user", content },
        ];
    }

    if (task === "jira_alignment") {
        const jiraKey = jira?.key || "(unknown)";
        const jiraSummary = jira?.summary || "(empty)";
        const jiraAC = jira?.acceptance_criteria || "(empty)";

        const prId = pull_request?.id || "(unknown)";
        const prTitle = pull_request?.title || "(empty)";
        const prDesc = pull_request?.description || "(empty)";

        const instr = (instructions || "").trim();

        // Compact, stable structure (few tokens, still clear)
        const content =
            `JIRA ${jiraKey}\n` +
            `${jiraSummary}\n\n` +
            `AC:\n${jiraAC}\n\n` +
            `PR ${prId} ${prTitle}\n` +
            `${prDesc}\n\n` +
            (instr ? `${instr}\n\n` : "") +
            `${safeDiff}`;

        return [
            { role: "system", content: systemPrompt },
            { role: "user", content },
        ];
    }

    // Unknown task: keep minimal framing
    const content =
        `TASK ${task || "(unknown)"}\n\n` +
        `${safeDiff}`;

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content },
    ];
}

app.post("/review", async (req, res) => {
    try {
        const activeIsLegacy = runtimeConfig.legacyEnabled;
        const { diff, task } = req.body || {};
        if (!diff) {
            return res.status(400).json({ error: "diff missing" });
        }

        const input = await buildMessagesForPayload(req.body);
        const client = activeIsLegacy ? sendLegacy : sendPrimary;

        console.log("[proxy] provider:", activeIsLegacy ? "legacy" : "responses", "maxDiffChars:", runtimeConfig.maxDiffChars);

        const { data, error, status } = await client({ input });
        if (error) {
            return res.status(status || 500).json({ error });
        }

        let outputText = extractOutputText(data);
        outputText = appendProviderFooter(outputText, data?.meta);
        const usage = data?.usage || {};

        const base = {
            output_text: outputText,
            usage: {
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0
            },
            meta: data?.meta || undefined
        };

        if (task === "jira_alignment") {
            return res.json({ alignment: outputText, output_text: outputText, ...base });
        }
        return res.json({ review: outputText, output_text: outputText, ...base });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Warm-up: fail fast if prompt files missing
(async () => {
    try {
        await Promise.all([
            loadPromptFile("code_review.system.txt"),
            loadPromptFile("jira_alignment.system.txt"),
            loadPromptFile("default.system.txt"),
        ]);
    } catch (e) {
        console.error("Prompt loading failed:", e);
        process.exit(1);
    }

    app.listen(8080, () => {
        console.log("llm-proxy listening on :8080");
        console.log("Provider mode:", runtimeConfig.legacyEnabled ? "legacy-chat-completions" : "responses-api");
        console.log("maxDiffChars:", runtimeConfig.maxDiffChars);
        console.log("Prompts dir:", PROMPTS_DIR);
    });
})();
