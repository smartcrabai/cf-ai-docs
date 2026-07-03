---
name: cf-ai-docs
description: Use this skill when you need to search, read, propose updates to, apply approved updates to, or audit documentation through the cf-ai-docs MCP server backed by Cloudflare AI Search, R2, D1, and Cloudflare Access.
---

# cf-ai-docs

Use the configured `cf-ai-docs` MCP server for documentation RAG and controlled documentation updates.

The remote MCP endpoint is protected by Cloudflare Access Managed OAuth. Tool execution depends on the authenticated Access identity: all authenticated users can search, read documents, and check indexing status (`get_index_status`), editor users can propose create/update/delete operations, and admin users can apply proposals or read audit logs.

## Workflow

1. Search before answering documentation questions.
   Use `search` with the user's query. Prefer `retrieval_type: "hybrid"` and keep `max_num_results` small unless the task requires broad coverage.

2. Fetch the full source before editing.
   Use `get_document` with the `document_key` or `document_id` returned by search. Keep the returned `sha256`; it is the update baseline.

3. Propose, do not directly apply.
   - To modify an existing document, use `propose_update` with the full replacement document in `proposed_content`, the current `sha256` as `expected_sha256`, and a short `rationale`.
   - To add a brand-new document, use `create_document` with `document_key` and `proposed_content`. It fails with a conflict if a document already exists at that key — use `propose_update` instead in that case.
   - To remove a document, use `delete_document` with `document_key` (or `document_id`) and the current `sha256` as `expected_sha256`.

4. Apply only after explicit human approval.
   Use `apply_update` with `proposal_id` and `confirm_apply: true` for proposals from any of `propose_update`, `create_document`, or `delete_document`. If the tool reports a conflict, fetch the document again and create a new proposal. For built-in storage, `apply_update` returns as soon as the write succeeds — it does not wait for AI Search indexing to finish.

5. Check indexing progress when it matters.
   After `apply_update` applies a create/update proposal, call `get_index_status` with the same `proposal_id` if you need to confirm the document has finished indexing (for example, before relying on it being searchable again).

6. Use audit logs for traceability.
   Use `audit_log` by `proposal_id`, `action`, or `actor` when you need to explain what happened.

## Tool Notes

- `search`: returns chunks with `item_key`; use that key to retrieve the full source.
- `get_document`: supports `source: "builtin"` for AI Search built-in storage, `source: "r2"` for R2 objects, and read-only `source: "website"` when the server allows website fetches.
- `propose_update`: stores a pending full-document replacement in D1 and uses SHA-256 optimistic locking.
- `create_document`: stores a pending new-document proposal; only valid when `document_key` does not already exist.
- `delete_document`: stores a pending deletion proposal, guarded by the current document SHA-256.
- `apply_update`: applies any pending proposal (create, update, or delete) to AI Search built-in storage or R2. Website crawler sources are read-only. Returns immediately once the write succeeds; AI Search indexing continues asynchronously.
- `get_index_status`: reports AI Search indexing progress for a proposal applied by `apply_update` (item status for built-in storage, sync job status for R2 when a sync was started). The first time it observes a built-in item reach a terminal state, it records an `index_completed`/`index_failed` audit event.
- `audit_log`: reads D1 audit events for search, read, proposal, apply, index completion/failure, and conflict events.

Never call `apply_update` without explicit approval from the user or an approved automation policy.
