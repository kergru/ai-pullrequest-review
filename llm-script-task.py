echo "=== PR/Bitbucket/Bamboo context ==="
env | sort | egrep -i 'pull|pr_|bitbucket|repository|branch'
echo "=== end ==="

export BB_TOKEN="${bamboo.BB_TOKEN}"
export JIRA_TOKEN="${bamboo.JIRA_TOKEN}"

echo "BB_TOKEN_LEN=${#BB_TOKEN}"

python3 << 'PY'
import os, re, json, urllib.request, urllib.error, hashlib, sys

# ---------------- helpers ----------------
def http_get(url, headers, timeout=60):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")

def http_post_json(url, payload, headers=None, timeout=180):
    headers = headers or {}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={**headers, "Content-Type": "application/json", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"_error": True, "status": e.code, "reason": e.reason, "body": body}

def txt(v):
    if not v: return ""
    if isinstance(v,str): return v.strip()
    return json.dumps(v, ensure_ascii=False)

def compact_diff(diff_text, context_lines=3, max_chars=120000):
    if not diff_text:
        return ""
    lines = diff_text.splitlines()
    keep = [False] * len(lines)

    def is_added(line):
        s = line.lstrip()
        return (s.startswith("+") and not s.startswith("+++")) or s.startswith("+ ")

    def is_removed(line):
        s = line.lstrip()
        return (s.startswith("-") and not s.startswith("---")) or s.startswith("- ")

    changed = []
    for i, line in enumerate(lines):
        # keep common diff markers (also if indented)
        if line.lstrip().startswith(("diff --git", "index ", "@@", "+++ ", "--- ")):
            keep[i] = True
            continue
        if is_added(line) or is_removed(line):
            changed.append(i)

    # If we found changes, keep N context around them
    if changed:
        for idx in changed:
            start = max(0, idx - context_lines)
            end = min(len(lines), idx + context_lines + 1)
            for j in range(start, end):
                keep[j] = True
    else:
        # Fallback: keep the first chunk of the diff (better than empty)
        out = "\n".join(lines)
        return out[:max_chars]

    out_lines = [lines[i] for i, k in enumerate(keep) if k]
    out = "\n".join(out_lines)
    if not out.strip():
        out = "\n".join(lines)
    return out[:max_chars]


def find_issue_key(*candidates):
    for c in candidates:
        if not c:
            continue
        m = re.search(r"\b[A-Z][A-Z0-9]+-\d+\b", c)
        if m:
            return m.group(0)
    return None

# ---------------- env ----------------
BB_URL = os.getenv("BB_URL","http://bitbucket:7990")
BB_TOKEN = os.getenv("BB_TOKEN","")
JIRA_URL = os.getenv("JIRA_URL","http://jira:8080")
JIRA_TOKEN = os.getenv("JIRA_TOKEN","")
LLM_PROXY_URL = os.getenv("LLM_PROXY_URL","http://llm-proxy:8080/review")

PR_ID = os.getenv("bamboo_repository_pr_key")
SOURCE = os.getenv("bamboo_repository_pr_sourceBranch")
TARGET = os.getenv("bamboo_repository_pr_targetBranch")
REPO_URL = os.getenv("bamboo_planRepository_repositoryUrl")
SHORT_BRANCH = os.getenv("bamboo_shortPlanBranchName")

DIFF_CONTEXT = int(os.getenv("DIFF_CONTEXT", "3"))
MAX_DIFF_CHARS = int(os.getenv("MAX_DIFF_CHARS", "120000"))

m = re.search(r"/([^/]+)/([^/]+)\.git$", REPO_URL or "")
if not m:
    print("ERROR: Could not parse PROJECT/REPO from REPO_URL:", REPO_URL)
    sys.exit(2)

PROJECT = m.group(1)
REPO = m.group(2)

bb_headers = {"Authorization": f"Bearer {BB_TOKEN}"}

print("REPO_URL=", REPO_URL)
print("PROJECT=", PROJECT, "REPO=", REPO)
print("PR_ID=", PR_ID)
print("BB_URL=", BB_URL)
print("SOURCE=", SOURCE or "(missing)")
print("SHORT_BRANCH=", SHORT_BRANCH or "(missing)")
print("TARGET=", TARGET or "(missing)")

# ---------------- PR DIFF ----------------
diff_url = f"{BB_URL}/rest/api/1.0/projects/{PROJECT}/repos/{REPO}/pull-requests/{PR_ID}/diff"
print("DIFF_URL=", diff_url)
diff = http_get(diff_url, bb_headers)
diff_sha = hashlib.sha256(diff.encode()).hexdigest()[:12]

diff_compact = compact_diff(diff, context_lines=DIFF_CONTEXT, max_chars=MAX_DIFF_CHARS)
print(f"DIFF_BYTES={len(diff)} COMPACT_BYTES={len(diff_compact)} sha256:{diff_sha}")

# ---------------- JIRA ----------------
issue_key = find_issue_key(SOURCE, SHORT_BRANCH)
if not issue_key:
    print("ERROR: Could not extract Jira issue key from SOURCE/SHORT_BRANCH.")
    sys.exit(2)

jira_headers = {"Authorization": f"Bearer {JIRA_TOKEN}"}
issue = json.loads(http_get(f"{JIRA_URL}/rest/api/2/issue/{issue_key}", jira_headers))

fields = issue["fields"]
jira_summary = txt(fields.get("summary"))
jira_desc = txt(fields.get("description"))
jira_ac = txt(fields.get("customfield_10112"))

# ---------------- LLM CALL ----------------
payload = {
    "task": "jira_alignment",
    "jira": {
        "key": issue_key,
        "summary": jira_summary,
        "description": jira_desc,
        "acceptance_criteria": jira_ac
    },
    "pull_request": {
        "id": PR_ID,
        "title": "",
        "description": ""
    },
    "diff": diff_compact,
    "instructions": "Check PR vs Jira AC. Evidence-based. Quote diff."
}

llm = http_post_json(LLM_PROXY_URL, payload)
print("LLM_RESPONSE_KEYS=", list(llm.keys()))
print("LLM_RESPONSE_HEAD=", json.dumps(llm, ensure_ascii=False)[:800])
alignment = ""
llm_err = None

if llm.get("_error"):
    llm_err = f"HTTP {llm['status']} {llm['reason']} | {llm['body'][:1200]}"
    print("LLM_ERROR:", llm_err)
else:
    alignment = llm.get("alignment") or llm.get("output_text") or ""
    print("LLM_OK: output_len=", len(alignment))

# ---------------- COMMENT ----------------
lines = []
lines.append("🤖 **AI Jira Alignment Review (PoC)**")
lines.append(f"- Jira: `{issue_key}`")
lines.append(f"- Source: `{SOURCE or SHORT_BRANCH or '(unknown)'}` → Target: `{TARGET or '(unknown)'}`")
lines.append(f"- Diff: `{len(diff)} bytes` → compact `{len(diff_compact)} bytes` (sha256:{diff_sha})")
lines.append("")

if alignment:
    lines.append(alignment)
else:
    lines.append("⚠️ Kein KI-Ergebnis verfügbar.")
    if llm_err:
        lines.append("\n```\n"+llm_err+"\n```")

comment = "\n".join(lines)

comment_url = f"{BB_URL}/rest/api/1.0/projects/{PROJECT}/repos/{REPO}/pull-requests/{PR_ID}/comments"
resp = http_post_json(comment_url, {"text": comment}, headers=bb_headers)

if resp.get("_error"):
    print("COMMENT_ERROR:", f"HTTP {resp['status']} {resp['reason']} | {resp['body'][:800]}")
    sys.exit(2)

print("Done.")
sys.exit(0)
PY
