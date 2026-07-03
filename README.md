# cf-ai-docs

Cloudflare Worker MCP server for LLM-agent documentation RAG and controlled documentation updates.

```text
LLM Agent
  -> Skill
  -> Custom MCP Worker (/mcp)
      - search
      - get_document
      - propose_update
      - create_document
      - delete_document
      - apply_update
      - get_index_status
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
- `create_document`: store a pending proposal for a brand-new document at a key that does not exist yet.
- `delete_document`: store a pending proposal to delete an existing document, guarded by the current SHA-256.
- `apply_update`: apply an approved proposal (create, update, or delete) to built-in storage or R2, rejecting stale baselines. For built-in storage this returns as soon as the write succeeds; AI Search indexing continues asynchronously.
- `get_index_status`: check AI Search indexing progress (built-in item status, or R2 sync job status) for a proposal applied by `apply_update`.
- `audit_log`: inspect D1 audit events for searches, reads, proposals, applies, index completion/failure, and conflicts.

The MCP endpoint is `POST /mcp` and `GET /mcp` via Streamable HTTP with SSE enabled. REST equivalents can be enabled under `/api/*` for local debugging and automation, but are disabled by default in deployed configuration.

## Production Setup From a Fresh Clone

Prerequisites:

- A Cloudflare account with Workers, D1, R2, AI Search, and Zero Trust Access available.
- A Cloudflare Zero Trust team domain such as `https://<team-name>.cloudflareaccess.com`.
- An identity provider configured in Cloudflare Access.
- A local shell with Bun and Git.
- Wrangler authenticated to the target account:

```sh
bunx wrangler login
```

Clone the repository and install dependencies:

```sh
git clone https://github.com/smartcrabai/cf-ai-docs.git
cd cf-ai-docs
bun install
```

Create Cloudflare resources. The default names below match `wrangler.jsonc`.

```sh
bunx wrangler ai-search namespace create default
bunx wrangler ai-search create docs --namespace default --type builtin --hybrid-search
bunx wrangler d1 create cf-ai-docs
bunx wrangler r2 bucket create cf-ai-docs
```

Record the D1 database ID printed by `wrangler d1 create`. You will use it as `d1_databases[0].database_id` for direct deploys, or as the `CF_D1_DATABASE_ID` GitHub secret for GitHub Actions deploys.

Choose the public MCP URL. For the default Worker name it will normally be:

```text
https://cf-ai-docs.<your-workers-subdomain>.workers.dev/mcp
```

If you use a custom domain, use that domain instead.

### Configure Cloudflare Access Managed OAuth in the Dashboard

Create an MCP server Access application in Cloudflare Zero Trust:

1. Open the Cloudflare dashboard.
2. Go to `Zero Trust > Access controls > AI controls`.
3. Open the `MCP servers` tab.
4. Select `Add an MCP server`.
5. Set the HTTP URL to your full MCP URL, including `/mcp`.
6. Configure an Access policy for the users allowed to reach this MCP server.
7. Select the identity provider for the application.
8. If you use a single IdP, enable instant authentication.
9. Save the MCP server.
10. Go to `Zero Trust > Access controls > Applications`.
11. Open the generated Access application.
12. Confirm the public hostname is the Worker hostname without `/mcp`.
13. In `Advanced settings`, enable `Managed OAuth`.
14. Enable `Allow localhost clients` and `Allow loopback clients` for local MCP clients such as Claude Code.
15. Save the application.
16. Copy the Access application `AUD tag`.

This Worker validates the `Cf-Access-Jwt-Assertion` header that Cloudflare Access forwards to the origin. It verifies the Access issuer, AUD tag, and JWT signature before serving MCP requests.

### Configure `wrangler.jsonc`

For direct local deploys, replace the placeholders in `wrangler.jsonc`:

- Replace `d1_databases[0].database_id` with the created D1 database ID.
- Set `vars.DEFAULT_AI_SEARCH_INSTANCE` to your AI Search instance name.
- Keep or change the `DOCS_BUCKET` binding depending on whether R2-backed updates are needed.
- Replace the Access and MCP vars:
  - `CF_ACCESS_TEAM_DOMAIN`: your Access team domain, for example `https://<team-name>.cloudflareaccess.com`.
  - `CF_ACCESS_AUD`: the AUD tag from the MCP server Access application.
  - `MCP_RESOURCE_URL`: the public MCP URL, for example `https://docs.example.com/mcp`.
  - `OAUTH_AUTHORIZATION_SERVER`: the Access authorization server, normally the Access team domain.
  - `MCP_ALLOWED_ORIGINS`: allowed browser origins for CORS, usually the Worker origin.
  - `MCP_ALLOWED_HOSTS`: allowed Host headers for DNS rebinding protection, usually the Worker hostname.
  - `AUTH_EDITOR_EMAILS`: comma-separated users allowed to create, update, and delete proposals.
  - `AUTH_ADMIN_EMAILS`: comma-separated users allowed to apply proposals and read audit logs.
  - `ENABLE_REST_API`: keep `false` for production unless you explicitly need authenticated REST endpoints.

Example:

```jsonc
{
  "vars": {
    "DEFAULT_AI_SEARCH_INSTANCE": "docs",
    "CF_ACCESS_TEAM_DOMAIN": "https://example.cloudflareaccess.com",
    "CF_ACCESS_AUD": "ACCESS_APP_AUD_TAG",
    "MCP_RESOURCE_URL": "https://cf-ai-docs.example.workers.dev/mcp",
    "OAUTH_AUTHORIZATION_SERVER": "https://example.cloudflareaccess.com",
    "MCP_ALLOWED_ORIGINS": "https://cf-ai-docs.example.workers.dev",
    "MCP_ALLOWED_HOSTS": "cf-ai-docs.example.workers.dev",
    "AUTH_EDITOR_EMAILS": "editor@example.com",
    "AUTH_ADMIN_EMAILS": "admin@example.com",
    "ENABLE_REST_API": "false"
  }
}
```

Apply migrations:

```sh
bun run db:migrate
```

Permission model:

- authenticated Access users: `search`, `get_document`, `get_index_status`
- `AUTH_EDITOR_EMAILS`: `propose_update`, `create_document`, `delete_document`
- `AUTH_ADMIN_EMAILS`: `apply_update`, `audit_log`

Deploy:

```sh
bun run deploy
```

### GitHub Actions Deployment

The included `Deploy` workflow rewrites `wrangler.jsonc` at deploy time so the repository can keep safe placeholder values. Configure these repository secrets:

- `CLOUDFLARE_API_TOKEN`: token allowed to deploy the Worker and run D1 migrations.
- `CLOUDFLARE_ACCOUNT_ID`: target Cloudflare account ID.
- `CF_D1_DATABASE_ID`: D1 database ID from `wrangler d1 create`.

Configure these repository variables:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `MCP_RESOURCE_URL`
- `OAUTH_AUTHORIZATION_SERVER`
- `MCP_ALLOWED_ORIGINS`
- `MCP_ALLOWED_HOSTS`
- `AUTH_EDITOR_EMAILS`
- `AUTH_ADMIN_EMAILS`
- `ENABLE_REST_API`

On every push to `main`, the workflow installs dependencies, injects the production D1 and Access/OAuth values into `wrangler.jsonc`, applies D1 migrations remotely, and deploys the Worker.

### Validate the Deployed MCP Server

After deployment, these endpoints should return Access/OAuth metadata:

```sh
curl -i https://<your-worker-host>/.well-known/oauth-authorization-server
curl -i https://<your-worker-host>/.well-known/oauth-protected-resource/mcp
curl -i https://<your-worker-host>/.well-known/cloudflare-access-protected-resource/mcp
```

An unauthenticated MCP request should return `401` with a `WWW-Authenticate` challenge from Cloudflare Access:

```sh
curl -i https://<your-worker-host>/mcp -H 'Accept: text/event-stream'
```

Connect an MCP client to:

```text
https://<your-worker-host>/mcp
```

For Claude Code:

```sh
claude mcp add --transport http cf-ai-docs https://<your-worker-host>/mcp
claude mcp login cf-ai-docs
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

REST endpoints are disabled in production config unless `ENABLE_REST_API=true`. Local mock mode enables them with `LOCAL_AUTH_BYPASS=true`.

Search:

```sh
curl -sS http://127.0.0.1:8787/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"How do we rotate API keys?","max_num_results":5}'
```

Propose an update:

```sh
curl -sS http://127.0.0.1:8787/api/propose_update \
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
curl -sS http://127.0.0.1:8787/api/apply_update \
  -H "Content-Type: application/json" \
  -d '{"proposal_id":"PROPOSAL_ID","confirm_apply":true}'
```

`apply_update` returns as soon as the write succeeds; check indexing progress separately:

```sh
curl -sS http://127.0.0.1:8787/api/get_index_status \
  -H "Content-Type: application/json" \
  -d '{"proposal_id":"PROPOSAL_ID"}'
```

## Agent Skill

The agent-facing skill lives at `skills/cf-ai-docs/SKILL.md`. Install or copy that skill into the LLM-agent environment and configure the MCP client to connect to:

```text
https://YOUR_WORKER/mcp
```

The MCP resource metadata endpoint is:

```text
https://YOUR_WORKER/.well-known/oauth-protected-resource/mcp
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
