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
	result?: {
		item?: { metadata?: Record<string, unknown> };
		sync_job?: { id: string };
	};
	status: string;
};

type AuditResponse = {
	events: Array<{ action: string }>;
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

	test("does not mark built-in updates applied when indexing fails", async () => {
		const env = createLocalMockEnv();
		const items = env.AI_SEARCH.get("docs").items as {
			uploadAndPoll: AiSearchInstance["items"]["uploadAndPoll"];
		};
		type UploadAndPoll = AiSearchInstance["items"]["uploadAndPoll"];
		const originalUploadAndPoll = items.uploadAndPoll.bind(
			items,
		) as UploadAndPoll;
		items.uploadAndPoll = (async (
			name: string,
			content: ReadableStream | Blob | string,
			options?: AiSearchUploadItemOptions & {
				pollIntervalMs?: number;
				timeoutMs?: number;
			},
		) => {
			const item = await originalUploadAndPoll(name, content, options);
			return { ...item, error: "forced failure", status: "error" };
		}) as AiSearchInstance["items"]["uploadAndPoll"];

		const document = await post(env, "/api/get_document", {
			document_key: "runbooks/api-keys.md",
			source: "builtin",
		});
		const documentBody = (await document.json()) as DocumentResponse;
		const proposal = await post(env, "/api/propose_update", {
			document_key: "runbooks/api-keys.md",
			expected_sha256: documentBody.sha256,
			proposed_content: `${documentBody.content}\nIndexing failure test.\n`,
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
