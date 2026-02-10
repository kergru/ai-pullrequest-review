export BB_TOKEN="${bamboo.BB_TOKEN}"
export JIRA_TOKEN="${bamboo.JIRA_TOKEN}"

python3 << 'PY'
import os, re, json, subprocess, urllib.request, urllib.error, sys, hashlib

def git(*args):
    return subprocess.check_output(["git"]+list(args), text=True)

def http_get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as r:
        return r.read().decode()

def http_post(url, payload, headers):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
        headers={**headers,"Content-Type":"application/json","Accept":"application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def issue_key(*xs):
    for x in xs:
        m = re.search(r"\b[A-Z][A-Z0-9]+-\d+\b", x or "")
        if m: return m.group(0)

BB_URL=os.getenv("BB_URL","http://bitbucket:7990")
JIRA_URL=os.getenv("JIRA_URL","http://jira:8080")
LLM=os.getenv("LLM_PROXY_URL","http://llm-proxy:8080/review")

BB_TOKEN=os.getenv("BB_TOKEN")
JIRA_TOKEN=os.getenv("JIRA_TOKEN")

PR=os.getenv("bamboo_repository_pr_key")
SRC=os.getenv("bamboo_repository_pr_sourceBranch")
TGT=os.getenv("bamboo_repository_pr_targetBranch")
SHORT=os.getenv("bamboo_shortPlanBranchName")
REPO_URL=os.getenv("bamboo_planRepository_repositoryUrl")

m=re.search(r"/([^/]+)/([^/]+)\.git$",REPO_URL)
PROJECT,REPO=m.group(1),m.group(2)

target="origin/"+re.sub(r"^refs/heads/","",TGT)
subprocess.call(["git","fetch","origin",target.split("/",1)[1]])

files=git("diff","--name-only",f"{target}...HEAD").splitlines()
diff=git("diff",f"{target}...HEAD")

context="\n\n=== FILE CONTEXT ===\n"
for f in files[:15]:
    if not f.endswith((".png",".jpg",".pdf",".lock",".jar",".class",".min.js")):
        try:
            c=git("show",f"HEAD:{f}")
            if len(c)<20000:
                context+=f"\n--- {f} ---\n"+c
            else:
                d=git("diff",f"{target}...HEAD","-U40","--",f)
                context+=f"\n--- {f} (snippet) ---\n"+d[:12000]
        except: pass

combined=(diff+"\n"+context)[:120000]

key=issue_key(SRC,SHORT)
issue=json.loads(http_get(f"{JIRA_URL}/rest/api/2/issue/{key}",
    {"Authorization":f"Bearer {JIRA_TOKEN}"}))

fields=issue["fields"]
payload={
 "task":"jira_alignment",
 "jira":{
  "key":key,
  "summary":fields.get("summary",""),
  "description":fields.get("description",""),
  "acceptance_criteria":fields.get("customfield_10112","")
 },
 "pull_request":{"id":PR,"title":"","description":""},
 "diff":combined
}

llm = http_post(LLM, payload, {})
text = llm.get("alignment") or llm.get("output_text","")

# Provider metadata
meta = llm.get("meta", {})
api = meta.get("api", "unknown-api")
model = meta.get("model", "unknown-model")

# --- metrics ---
diff_bytes = len(diff.encode("utf-8", errors="replace"))
diff_sha = hashlib.sha256(diff.encode("utf-8", errors="replace")).hexdigest()[:12]
payload_chars = len(combined)
changed_files_text = len(files)

# --- token usage ---
usage = llm.get("usage", {})
in_tok = usage.get("input_tokens", 0)
out_tok = usage.get("output_tokens", 0)
tot_tok = usage.get("total_tokens", 0)

# --- comment ---
lines = []
lines.append("🤖 **AI Jira Alignment Review**")
lines.append("")
lines.append(f"- Jira: `{key}`")
lines.append(f"- Changed files (text): `{changed_files_text}`")
lines.append("")
lines.append(text)
lines.append("")
lines.append("---")
lines.append(f"- Diff bytes: `{diff_bytes}` (sha256:{diff_sha})")
lines.append(f"- Payload chars: `{payload_chars}`")
lines.append(f"- LLM: api `{api}` / model `{model}`")
lines.append(f"- Tokens: in `{in_tok}` / out `{out_tok}` / total `{tot_tok}`")

comment = "\n".join(lines)

url = f"{BB_URL}/rest/api/1.0/projects/{PROJECT}/repos/{REPO}/pull-requests/{PR}/comments"
http_post(url, {"text": comment}, {"Authorization": f"Bearer {BB_TOKEN}"})
PY
