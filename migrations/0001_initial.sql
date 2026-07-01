CREATE TABLE IF NOT EXISTS update_proposals (
	proposal_id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'applied', 'rejected', 'conflict', 'failed')),
	target_source TEXT NOT NULL CHECK (target_source IN ('builtin', 'r2', 'website')),
	ai_search_instance TEXT,
	document_id TEXT,
	document_key TEXT NOT NULL,
	r2_key TEXT,
	expected_sha256 TEXT NOT NULL,
	proposed_sha256 TEXT NOT NULL,
	proposed_content TEXT NOT NULL,
	rationale TEXT NOT NULL DEFAULT '',
	metadata_json TEXT,
	author TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	applied_at TEXT,
	applied_by TEXT,
	apply_result_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_update_proposals_status_created
ON update_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_update_proposals_document
ON update_proposals (target_source, ai_search_instance, document_key);

CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id TEXT NOT NULL UNIQUE,
	proposal_id TEXT,
	action TEXT NOT NULL,
	actor TEXT NOT NULL,
	target_source TEXT,
	ai_search_instance TEXT,
	document_key TEXT,
	document_id TEXT,
	metadata_json TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_proposal_id
ON audit_events (proposal_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_action
ON audit_events (action, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor
ON audit_events (actor, id DESC);
