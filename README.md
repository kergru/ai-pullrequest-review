# Atlassian CI/CD with AI Assistance

Overview:
- Project: Local CI/CD setup using Bitbucket, Bamboo (incl. remote agent), and Jira, extended with an LLM proxy for AI-powered code reviews.
- Goal: Automate code analysis on pull requests/commits and surface results in build logs and tickets.
- Jira integration benefit: Builds and review outcomes link directly to issues (acceptance criteria, descriptions), merging development and ticket workflows for traceability.

Core components:
- `docker-compose.yml`: Starts Postgres, Bitbucket, Bamboo, the Bamboo agent, Jira, and the LLM proxy; ensures networking and persistent volumes.
- Script task `llm-script-task.py`: Runs inside the Bamboo plan; collects diffs/context and calls the LLM proxy for the AI review.
- LLM proxy `llm-proxy/server.js`: HTTP service that drives the selected model (via `.env` with `OPENAI_API_KEY` and `OPENAI_MODEL`) and orchestrates code analysis with curated prompts.

## Setup

1) Start containers via `docker-compose.yml`
* Bitbucket
* Bamboo
* Bamboo Agent
* Jira
* PostgreSQL (shared for Bitbucket, Bamboo and Jira)
* LLM Proxy (AI integration)

2) Bitbucket
* Create a project/workspace.
* Create a repository.
* Link Bitbucket with Bamboo (Application Links: OAuth, not OAuth2).
* Ensure the Bamboo agent has access (approve on Bamboo server; repo credentials via SSH key or token).

3) Bamboo
* Link Bamboo with Bitbucket (Application Links: OAuth, not OAuth2).
* Configure a Linked Repository.
* Approve the remote agent (see step 4).
* Create a build plan.
* Add the script task: `llm-script-task.py`.
* Set plan variables: `JIRA_TOKEN`, `BITBUCKET_TOKEN` (and optionally `OPENAI_API_KEY`).
* Add trigger: Bitbucket Repository Trigger.
* Enable the plan.

4) Bamboo Agent
* Purpose: Executes build/deploy jobs defined on the Bamboo server (e.g., the `llm-script-task.py` task). Connects automatically and reports capabilities.
* In this setup, the agent runs as the `bamboo-agent` service.
  * Image: `atlassian/bamboo-agent-base:latest`
  * Connection: `BAMBOO_SERVER: http://bamboo:8085/agentServer/` (see `docker-compose.yml`)
* Steps:
  1. Start docker-compose (step 1). The agent will attempt to reach the Bamboo server.
  2. In Bamboo Administration → Agents, approve the new remote agent.
  3. Check/add capabilities:
     - Python runtime for `llm-script-task.py` (agent image includes Java; add Python if needed or run via container/script wrapper).
     - Git should be available; add if missing.
  4. Ensure the linked repository is set so the agent can check out code.
  5. Provide plan variables (tokens); the agent receives them at runtime.

5) Jira
* Create a project and issues.
* Link Bamboo with Jira (Application Links: OAuth, not OAuth2).

6) LLM Proxy
* Logic resides in `llm-proxy/server.js`.
* Provide an OpenAI API key: create a `.env` with `OPENAI_API_KEY=<key>`.
* Optionally set the model in `.env`, e.g. `OPENAI_MODEL=gpt-4`.
