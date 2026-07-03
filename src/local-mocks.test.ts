import { describe, expect, test } from "bun:test";
import { handleRequest } from "./index";
import { createLocalMockEnv } from "./local-mocks";

type SearchResponse = {
	result_count: number;
	chunks: Array<{ item_key: string }>;
};

type DocumentResponse = {
	content: string;
	instance?: string;
	item_info?: { metadata?: Record<string, unknown> };
	r2_metadata?: { custom_metadata?: Record<string, string> };
	sha256: string;
};

type ProposalResponse = {
	proposal_id: string;
	status: string;
};

type ApplyResponse = {
	proposal_id: string;
	result?: {
		item?: { id?: string; metadata?: Record<string, unknown> };
		indexing_status?: string;
		indexing_note?: string;
		sync_job?: { id: string };
	};
	status: string;
};

type AuditResponse = {
	events: Array<{ action: string }>;
};

type IndexStatusResponse = {
	proposal_id: string;
	proposal_status: string;
	operation: string;
	target_source: string;
	note?: string;
	indexing?: {
		document_id?: string;
		key?: string;
		status?: string;
		error?: string;
		id?: string;
	};
};

describe("local mock environment", () => {
	test("runs search, get, propose, apply, and audit locally", async () => {
		const env = createLocalMockEnv();

		const search = await post(env, "/api/search", {
			max_num_results: 5,
			query: "rotate API keys",
		});
		expect(search.status).toBe(200);
		const searchBody = (await search.json()) as SearchResponse;
		expect(searchBody.result_count).toBeGreaterThan(0);
		expect(searchBody.chunks.at(0)?.item_key).toBe("runbooks/api-keys.md");

		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		expect(document.status).toBe(200);
		const documentBody = (await document.json()) as DocumentResponse;
		expect(documentBody.content).toContain("Rotate API keys every 90 days.");

		const proposedContent = `${documentBody.content}\n5. Record the rotation in the audit log.\n`;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: proposedContent,
			rationale: "Add audit logging step.",
			source: "builtin",
		});
		expect(proposal.status).toBe(200);
		const proposalBody = (await proposal.json()) as ProposalResponse;
		expect(proposalBody.status).toBe("pending");

		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		expect(appliedBody.status).toBe("applied");

		const updated = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const updatedBody = (await updated.json()) as DocumentResponse;
		expect(updatedBody.content).toContain(
			"Record the rotation in the audit log.",
		);
		expect(updatedBody.item_info?.metadata?.area).toBe("runbooks");
		expect(updatedBody.item_info?.metadata?.title).toBe("API Key Rotation");

		const audit = await post(env, "/api/audit_log", {
			proposal_id: proposalBody.proposal_id,
		});
		expect(audit.status).toBe(200);
		const auditBody = (await audit.json()) as AuditResponse;
		expect(auditBody.events.map((event) => event.action)).toContain(
			"apply_update",
		);
	});

	test("returns 400 for malformed JSON", async () => {
		const response = await handleRequest(
			new Request("http://localhost/api/search", {
				body: "{",
				headers: {
					"Content-Type": "application/json",
				},
				method: "POST",
			}),
			createLocalMockEnv(),
			executionContext(),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Request body must be valid JSON.");
	});

	test("requires expected_sha256 when proposing an update", async () => {
		const env = createLocalMockEnv();
		const response = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			proposed_content: "new content",
			source: "builtin",
		});

		expect(response.status).toBe(400);
	});

	test("only one concurrent apply can claim a proposal", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "architecture/rag-updates.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "architecture/rag-updates.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nConcurrency is guarded by proposal status.\n`,
			rationale: "Exercise concurrent apply protection.",
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;

		const responses = await Promise.all([
			post(env, "/api/apply_update", {
				confirm_apply: true,
				proposal_id: proposalBody.proposal_id,
			}),
			post(env, "/api/apply_update", {
				confirm_apply: true,
				proposal_id: proposalBody.proposal_id,
			}),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
	});

	test("preserves R2 metadata and starts sync when an instance is requested", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			instance: "docs",
			r2_key: "r2/policies/access.md",
			source: "r2",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		expect(documentBody.instance).toBe("docs");

		const proposal = await post(env, "/api/propose_update", {
			expected_sha256: documentBody.sha256,
			instance: "docs",
			metadata: { reviewed: "true" },
			proposed_content: `${documentBody.content}\nAccess policies are reviewed quarterly.\n`,
			r2_key: "r2/policies/access.md",
			rationale: "Add review cadence.",
			source: "r2",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;

		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		expect(typeof appliedBody.result?.sync_job?.id).toBe("string");

		const updated = await post(env, "/api/get_document", {
			r2_key: "r2/policies/access.md",
			source: "r2",
		});
		const updatedBody = (await updated.json()) as DocumentResponse;
		expect(updatedBody.content).toContain("reviewed quarterly");
		expect(updatedBody.r2_metadata?.custom_metadata?.area).toBe("security");
		expect(updatedBody.r2_metadata?.custom_metadata?.title).toBe(
			"Access Policy",
		);
		expect(updatedBody.r2_metadata?.custom_metadata?.reviewed).toBe("true");
	});

	test("creates, updates, searches, and deletes a document end to end", async () => {
		const env = createLocalMockEnv();

		const created = await post(env, "/api/create_document", {
			document_key: "test/hello.md",
			proposed_content: "# Hello Test\n\nInitial content.\n",
			rationale: "e2e create",
			source: "builtin",
		});
		expect(created.status).toBe(200);
		const createdBody = (await created.json()) as ProposalResponse;
		expect(createdBody.status).toBe("pending");

		const createApplied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: createdBody.proposal_id,
		});
		expect(createApplied.status).toBe(200);

		const searchAfterCreate = await post(env, "/api/search", {
			query: "Hello Test",
		});
		const searchAfterCreateBody =
			(await searchAfterCreate.json()) as SearchResponse;
		expect(
			searchAfterCreateBody.chunks.some(
				(chunk) => chunk.item_key === "test/hello.md",
			),
		).toBe(true);

		const fetched = await post(env, "/api/get_document", {
			document_key: "test/hello.md",
			source: "builtin",
		});
		const fetchedBody = (await fetched.json()) as DocumentResponse;

		const updateProposal = await post(env, "/api/propose_update", {
			document_key: "test/hello.md",
			expected_sha256: fetchedBody.sha256,
			proposed_content: "# Hello Test\n\nUpdated content.\n",
			rationale: "e2e update",
			source: "builtin",
		});
		const updateProposalBody =
			(await updateProposal.json()) as ProposalResponse;
		const updateApplied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: updateProposalBody.proposal_id,
		});
		expect(updateApplied.status).toBe(200);

		const afterUpdate = await post(env, "/api/get_document", {
			document_key: "test/hello.md",
			source: "builtin",
		});
		const afterUpdateBody = (await afterUpdate.json()) as DocumentResponse;
		expect(afterUpdateBody.content).toContain("Updated content.");

		const deleteProposal = await post(env, "/api/delete_document", {
			document_key: "test/hello.md",
			expected_sha256: afterUpdateBody.sha256,
			rationale: "e2e delete",
			source: "builtin",
		});
		expect(deleteProposal.status).toBe(200);
		const deleteProposalBody =
			(await deleteProposal.json()) as ProposalResponse;
		const deleteApplied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: deleteProposalBody.proposal_id,
		});
		expect(deleteApplied.status).toBe(200);

		const afterDelete = await post(env, "/api/get_document", {
			document_key: "test/hello.md",
			source: "builtin",
		});
		expect(afterDelete.status).toBe(404);
	});

	test("create_document conflicts when the key already exists", async () => {
		const env = createLocalMockEnv();
		const response = await post(env, "/api/create_document", {
			document_key: "runbooks/api-keys.md",
			proposed_content: "duplicate",
			source: "builtin",
		});
		expect(response.status).toBe(409);
	});

	test("applies built-in updates without polling and reports indexing status", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nNon-blocking apply test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;

		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		expect(appliedBody.status).toBe("applied");
		expect(appliedBody.result?.indexing_status).toBe("completed");
		expect(appliedBody.result?.indexing_note).toContain("get_index_status");
	});

	test("get_index_status reports the AI Search item state for an applied built-in proposal", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nIndex status test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);

		const status = await post(env, "/api/get_index_status", {
			proposal_id: proposalBody.proposal_id,
		});
		expect(status.status).toBe(200);
		const statusBody = (await status.json()) as IndexStatusResponse;
		expect(statusBody.proposal_status).toBe("applied");
		expect(statusBody.target_source).toBe("builtin");
		expect(statusBody.indexing?.status).toBe("completed");
		expect(statusBody.indexing?.key).toBe("runbooks/api-keys.md");
	});

	test("get_index_status reports the sync job state for an applied R2 proposal", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			instance: "docs",
			r2_key: "r2/policies/access.md",
			source: "r2",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			expected_sha256: documentBody.sha256,
			instance: "docs",
			proposed_content: `${documentBody.content}\nSync job status test.\n`,
			r2_key: "r2/policies/access.md",
			rationale: "Exercise get_index_status for R2.",
			source: "r2",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		const syncJobId = appliedBody.result?.sync_job?.id;
		expect(typeof syncJobId).toBe("string");

		const status = await post(env, "/api/get_index_status", {
			proposal_id: proposalBody.proposal_id,
		});
		expect(status.status).toBe(200);
		const statusBody = (await status.json()) as IndexStatusResponse & {
			indexing?: { id?: string };
		};
		expect(statusBody.proposal_status).toBe("applied");
		expect(statusBody.target_source).toBe("r2");
		expect(statusBody.indexing?.id).toBe(syncJobId);
	});

	test("get_index_status returns 404 for an unknown proposal_id", async () => {
		const env = createLocalMockEnv();
		const status = await post(env, "/api/get_index_status", {
			proposal_id: "does-not-exist",
		});
		expect(status.status).toBe(404);
	});

	test("marks a built-in update failed when upload() returns a synchronous error status", async () => {
		const env = createLocalMockEnv();
		const items = env.AI_SEARCH.get("docs").items;
		const originalUpload = items.upload.bind(items);
		items.upload = (async (
			name: string,
			content: ReadableStream | Blob | string,
			options?: AiSearchUploadItemOptions,
		) => {
			const item = await originalUpload(name, content, options);
			return {
				...item,
				error: "forced synchronous rejection",
				status: "error",
			};
		}) as typeof items.upload;

		try {
			const document = await post(env, "/api/get_document", {
				document_key: "runbooks/api-keys.md",
				source: "builtin",
			});
			const documentBody = (await document.json()) as DocumentResponse;
			const proposal = await post(env, "/api/propose_update", {
				document_key: "runbooks/api-keys.md",
				expected_sha256: documentBody.sha256,
				proposed_content: `${documentBody.content}\nSynchronous upload failure test.\n`,
				source: "builtin",
			});
			const proposalBody = (await proposal.json()) as ProposalResponse;

			const applied = await post(env, "/api/apply_update", {
				confirm_apply: true,
				proposal_id: proposalBody.proposal_id,
			});
			expect(applied.status).toBe(502);

			const audit = await post(env, "/api/audit_log", {
				proposal_id: proposalBody.proposal_id,
			});
			const auditBody = (await audit.json()) as AuditResponse;
			expect(auditBody.events.map((event) => event.action)).toContain(
				"apply_update_failed",
			);
		} finally {
			items.upload = originalUpload;
		}
	});

	test("get_index_status returns 502 (not 404) when the AI Search lookup fails for a reason other than not-found", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nTransient failure test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);

		const items = env.AI_SEARCH.get("docs").items;
		const originalGet = items.get.bind(items);
		items.get = ((_itemId: string) =>
			({
				info: async () => {
					throw new Error("transient upstream failure");
				},
			}) as unknown as AiSearchItem) as typeof items.get;
		try {
			const status = await post(env, "/api/get_index_status", {
				proposal_id: proposalBody.proposal_id,
			});
			expect(status.status).toBe(502);
		} finally {
			items.get = originalGet;
		}
	});

	test("get_index_status records an index_completed audit event once per terminal status", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nTerminal status audit test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);

		const firstStatus = await post(env, "/api/get_index_status", {
			proposal_id: proposalBody.proposal_id,
		});
		expect(firstStatus.status).toBe(200);

		const secondStatus = await post(env, "/api/get_index_status", {
			proposal_id: proposalBody.proposal_id,
		});
		expect(secondStatus.status).toBe(200);

		const audit = await post(env, "/api/audit_log", {
			proposal_id: proposalBody.proposal_id,
		});
		const auditBody = (await audit.json()) as AuditResponse;
		const completedEvents = auditBody.events.filter(
			(event) => event.action === "index_completed",
		);
		expect(completedEvents).toHaveLength(1);
	});

	test("get_index_status records an index_failed audit event once when async indexing ends in error", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nAsync indexing failure test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		const itemId = appliedBody.result?.item?.id;
		expect(typeof itemId).toBe("string");

		const items = env.AI_SEARCH.get("docs").items;
		const originalGet = items.get.bind(items);
		items.get = ((id: string) => {
			if (id !== itemId) {
				return originalGet(id);
			}
			return {
				info: async () => ({
					id,
					key: "runbooks/api-keys.md",
					status: "error",
					error: "async indexing failure",
				}),
			} as unknown as AiSearchItem;
		}) as typeof items.get;

		try {
			const firstStatus = await post(env, "/api/get_index_status", {
				proposal_id: proposalBody.proposal_id,
			});
			expect(firstStatus.status).toBe(200);
			const firstBody = (await firstStatus.json()) as IndexStatusResponse;
			expect(firstBody.indexing?.status).toBe("error");

			const secondStatus = await post(env, "/api/get_index_status", {
				proposal_id: proposalBody.proposal_id,
			});
			expect(secondStatus.status).toBe(200);

			const audit = await post(env, "/api/audit_log", {
				proposal_id: proposalBody.proposal_id,
			});
			const auditBody = (await audit.json()) as AuditResponse;
			const failedEvents = auditBody.events.filter(
				(event) => event.action === "index_failed",
			);
			expect(failedEvents).toHaveLength(1);
		} finally {
			items.get = originalGet;
		}
	});

	test("get_index_status treats a skipped item as terminal and records index_completed", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nSkipped status test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;
		const applied = await post(env, "/api/apply_update", {
			confirm_apply: true,
			proposal_id: proposalBody.proposal_id,
		});
		expect(applied.status).toBe(200);
		const appliedBody = (await applied.json()) as ApplyResponse;
		const itemId = appliedBody.result?.item?.id;
		expect(typeof itemId).toBe("string");

		const items = env.AI_SEARCH.get("docs").items;
		const originalGet = items.get.bind(items);
		items.get = ((id: string) => {
			if (id !== itemId) {
				return originalGet(id);
			}
			return {
				info: async () => ({
					id,
					key: "runbooks/api-keys.md",
					status: "skipped",
				}),
			} as unknown as AiSearchItem;
		}) as typeof items.get;

		try {
			const status = await post(env, "/api/get_index_status", {
				proposal_id: proposalBody.proposal_id,
			});
			expect(status.status).toBe(200);
			const statusBody = (await status.json()) as IndexStatusResponse;
			expect(statusBody.indexing?.status).toBe("skipped");

			const audit = await post(env, "/api/audit_log", {
				proposal_id: proposalBody.proposal_id,
			});
			const auditBody = (await audit.json()) as AuditResponse;
			const completedEvents = auditBody.events.filter(
				(event) => event.action === "index_completed",
			);
			expect(completedEvents).toHaveLength(1);
			const failedEvents = auditBody.events.filter(
				(event) => event.action === "index_failed",
			);
			expect(failedEvents).toHaveLength(0);
		} finally {
			items.get = originalGet;
		}
	});

	test("get_index_status does not call AI Search for an unapplied proposal", async () => {
		const env = createLocalMockEnv();
		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nPending proposal test.\n`,
			source: "builtin",
		});
		const proposalBody = (await proposal.json()) as ProposalResponse;

		const items = env.AI_SEARCH.get("docs").items;
		const originalGet = items.get.bind(items);
		items.get = () => {
			throw new Error(
				"get_index_status must not call AI Search for a pending proposal",
			);
		};
		try {
			const status = await post(env, "/api/get_index_status", {
				proposal_id: proposalBody.proposal_id,
			});
			expect(status.status).toBe(200);
			const statusBody = (await status.json()) as IndexStatusResponse;
			expect(statusBody.proposal_status).toBe("pending");
			expect(statusBody.indexing).toBeUndefined();
			expect(statusBody.note).toBeTruthy();
		} finally {
			items.get = originalGet;
		}
	});
});

function post(
	env: ReturnType<typeof createLocalMockEnv>,
	path: string,
	body: unknown,
) {
	return handleRequest(
		new Request(`http://localhost${path}`, {
			body: JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
			},
			method: "POST",
		}),
		env,
		executionContext(),
	);
}

function executionContext(): ExecutionContext {
	return {
		passThroughOnException() {},
		props: {},
		tracing: {},
		waitUntil() {},
	} as unknown as ExecutionContext;
}
