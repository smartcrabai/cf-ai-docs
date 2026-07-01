# cf-ai-docs

Cloudflare Worker MCP server for LLM-agent documentation RAG and controlled documentation updates.

```text
LLM Agent
  -> Skill
  -> Custom MCP Worker (/mcp)
      - search
      - get_document
      - propose_update
      - apply_update
      - audit_log
        -> Cloudflare AI Search
        -> R2 / built-in storage / website crawler
        -> D1 audit and proposal store
        -> Cloudflare Access
```

## What It Provides

- `search`: query Cloudflare AI Search and return ranked chunks with source keys.
- `get_document`: fetch full documents from AI Search built-in storage, R2, or allowed website URLs.
- `propose_update`: store a pending full-document replacement with SHA-256 optimistic locking.
- `apply_update`: apply an approved proposal to built-in storage or R2, rejecting stale baselines.
- `audit_log`: inspect D1 audit events for searches, reads, proposals, applies, and conflicts.

The MCP endpoint is `POST /mcp` and `GET /mcp` via Streamable HTTP. REST equivalents are available under `/api/*` for debugging and automation.

## Setup

Install dependencies:

```sh
bun install
```

Create Cloudflare resources:

```sh
wrangler ai-search namespace create default
wrangler ai-search create docs --namespace default --type builtin --hybrid-search
wrangler d1 create cf-ai-docs
wrangler r2 bucket create cf-ai-docs
```

Update `wrangler.jsonc`:

- Replace `d1_databases[0].database_id` with the created D1 database ID.
- Set `vars.DEFAULT_AI_SEARCH_INSTANCE` to your AI Search instance name.
- Keep or change the `DOCS_BUCKET` binding depending on whether R2-backed updates are needed.

Apply migrations:

```sh
bun run db:migrate
```

Configure authentication. Set a Worker secret for service-to-service MCP and REST clients:

```sh
wrangler secret put AGENT_API_TOKEN
```

Cloudflare Access can still sit in front of the Worker. The app ignores client-supplied `Cf-Access-*` identity headers by default; set `TRUST_CF_ACCESS_HEADERS=true` only when the Worker route cannot be reached except through Cloudflare Access and you want audit logs to use the Access identity.

Deploy:

```sh
bun run deploy
```

## Local Development

```sh
bun run dev
```

AI Search currently has no local simulator, so the `AI_SEARCH` binding is configured as remote.

For fully local checks without Cloudflare remote bindings, use the in-memory mock server:

```sh
bun run dev:mock
```

It starts `http://127.0.0.1:8787` by default and exercises the same REST handler with local in-memory mocks for:

- AI Search namespace, instances, search, items, uploads, and jobs
- D1 proposal and audit-log tables
- R2 object reads and writes

Seed documents:

- `runbooks/api-keys.md`
- `architecture/rag-updates.md`
- `r2/policies/access.md`

You can replace seed documents with a JSON file:

```sh
LOCAL_DOCS_SEED=./local-docs.json bun run dev:mock
```

Expected JSON shape:

```json
[
  {
    "key": "runbooks/example.md",
    "content": "# Example\nLocal document content",
    "metadata": { "area": "runbooks" }
  },
  {
    "source": "r2",
    "key": "r2/example.md",
    "content": "# R2 Example\nLocal R2 document"
  }
]
```

`dev:mock` is intended for local behavior checks and tests. It does not serve `/mcp`, because the Cloudflare Agents MCP handler depends on the Cloudflare Workers runtime. Use `bun run dev` or `wrangler deploy --dry-run` when you need to validate Cloudflare runtime wiring and MCP transport behavior.

## REST Examples

Search:

```sh
curl -sS https://YOUR_WORKER/api/search \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"How do we rotate API keys?","max_num_results":5}'
```

Propose an update:

```sh
curl -sS https://YOUR_WORKER/api/propose_update \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "builtin",
    "instance": "docs",
    "document_key": "runbooks/api-keys.md",
    "expected_sha256": "CURRENT_SHA_FROM_GET_DOCUMENT",
    "proposed_content": "# Full replacement document\n...",
    "rationale": "Clarify rotation steps."
  }'
```

Apply after approval:

```sh
curl -sS https://YOUR_WORKER/api/apply_update \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"proposal_id":"PROPOSAL_ID","confirm_apply":true}'
```

## Agent Skill

The agent-facing skill lives at `skills/cf-ai-docs/SKILL.md`. Install or copy that skill into the LLM-agent environment and configure the MCP client to connect to:

```text
https://YOUR_WORKER/mcp
```

The skill requires agents to search first, fetch full source before editing, propose updates before applying, and only call `apply_update` after explicit approval.

## E2E

Local REST behavior can be checked with runn:

```sh
bun run e2e:mock
```

The script starts `src/local-dev.ts` on `127.0.0.1:18787`, waits for `/health`, then runs `e2e/runn/*.yml`. It requires a `runn` binary on `PATH`, or a binary path passed with `RUNN_BIN`.

Install runn directly:

```sh
brew install k1LoW/tap/runn
```

To use a specific binary:

```sh
RUNN_BIN=/path/to/runn bun run e2e:mock
```
