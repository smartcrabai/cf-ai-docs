---
name: cf-ai-docs
description: Use this skill when you need to search, read, propose updates to, apply approved updates to, or audit documentation through the cf-ai-docs MCP server backed by Cloudflare AI Search, R2, D1, and Cloudflare Access.
---

# cf-ai-docs

Use the configured `cf-ai-docs` MCP server for documentation RAG and controlled documentation updates.

## Workflow

1. Search before answering documentation questions.
   Use `search` with the user's query. Prefer `retrieval_type: "hybrid"` and keep `max_num_results` small unless the task requires broad coverage.

2. Fetch the full source before editing.
   Use `get_document` with the `document_key` or `document_id` returned by search. Keep the returned `sha256`; it is the update baseline.

3. Propose, do not directly apply.
   Use `propose_update` with the full replacement document in `proposed_content`, the current `sha256` as `expected_sha256`, and a short `rationale`.

4. Apply only after explicit human approval.
   Use `apply_update` with `proposal_id` and `confirm_apply: true`. If the tool reports a conflict, fetch the document again and create a new proposal.

5. Use audit logs for traceability.
   Use `audit_log` by `proposal_id`, `action`, or `actor` when you need to explain what happened.

## Tool Notes

- `search`: returns chunks with `item_key`; use that key to retrieve the full source.
- `get_document`: supports `source: "builtin"` for AI Search built-in storage, `source: "r2"` for R2 objects, and read-only `source: "website"` when the server allows website fetches.
- `propose_update`: stores a pending full-document replacement in D1 and uses SHA-256 optimistic locking.
- `apply_update`: writes to AI Search built-in storage or R2. Website crawler sources are read-only.
- `audit_log`: reads D1 audit events for search, read, proposal, apply, and conflict events.

Never call `apply_update` without explicit approval from the user or an approved automation policy.
