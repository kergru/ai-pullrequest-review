import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_DIFF_CHARS = parseInt(process.env.MAX_DIFF_CHARS || "120000", 10);
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
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
    return String(diff || "").slice(0, MAX_DIFF_CHARS);
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
        if (!OPENAI_API_KEY) {
            return res.status(500).json({ error: "OPENAI_API_KEY missing" });
        }

        const { diff, task } = req.body || {};
        if (!diff) {
            return res.status(400).json({ error: "diff missing" });
        }

        const input = await buildMessagesForPayload(req.body);

        const r = await fetch(`${OPENAI_BASE_URL}/responses`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                input,
            }),
        });

        const text = await r.text();
        if (!r.ok) {
            return res.status(r.status).json({ error: text });
        }

        const data = JSON.parse(text);
        //console.log("RAW RESPONSE:", JSON.stringify(data, null, 2).slice(0, 2000));

        const outputText = extractOutputText(data);
        const usage = data?.usage || {};

        const base = {
            output_text: outputText,
            usage: {
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0
            }
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
        console.log("Using model:", MODEL);
        console.log("Prompts dir:", PROMPTS_DIR);
    });
})();
