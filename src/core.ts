import { z } from "zod";

const DEFAULT_PROPOSAL_MAX_BYTES = 2_000_000;
const DEFAULT_UPDATE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_UPDATE_POLL_TIMEOUT_MS = 30_000;

export interface Env {
	AI_SEARCH: AiSearchNamespace;
	DB?: D1Database;
	DOCS_BUCKET?: R2Bucket;
	DEFAULT_AI_SEARCH_INSTANCE?: string;
	REQUIRE_AUTH?: string;
	AGENT_API_TOKEN?: string;
	TRUST_CF_ACCESS_HEADERS?: string;
	PROPOSAL_MAX_BYTES?: string;
	UPDATE_POLL_INTERVAL_MS?: string;
	UPDATE_POLL_TIMEOUT_MS?: string;
	ALLOW_WEBSITE_FETCH?: string;
}

export type Actor = {
	id: string;
	kind: "cloudflare-access" | "bearer" | "anonymous";
	email?: string;
};

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

const optionalNonEmptyString = z.string().trim().min(1).optional();

export const DocumentSourceSchema = z.enum(["builtin", "r2", "website"]);

export const SearchInputSchema = z
	.object({
		query: z.string().trim().min(1),
		instance: optionalNonEmptyString,
		instance_ids: z.array(z.string().trim().min(1)).min(1).max(10).optional(),
		retrieval_type: z.enum(["vector", "keyword", "hybrid"]).default("hybrid"),
		max_num_results: z.number().int().min(1).max(50).default(10),
		match_threshold: z.number().min(0).max(1).optional(),
		context_expansion: z.number().int().min(0).max(3).optional(),
		metadata_only: z.boolean().optional(),
		filters: z.record(z.string(), z.unknown()).optional(),
		query_rewrite: z.boolean().optional(),
		reranking: z.boolean().optional(),
		cache: z.boolean().optional(),
	})
	.refine((input) => !(input.instance && input.instance_ids), {
		message: "Use either instance or instance_ids, not both.",
		path: ["instance_ids"],
	});

export const GetDocumentInputSchema = z.object({
	source: DocumentSourceSchema.default("builtin"),
	instance: optionalNonEmptyString,
	document_id: optionalNonEmptyString,
	document_key: optionalNonEmptyString,
	r2_key: optionalNonEmptyString,
	url: z.string().url().optional(),
});

export const ProposeUpdateInputSchema = GetDocumentInputSchema.extend({
	expected_sha256: z.string().trim().min(1),
	proposed_content: z.string().min(1),
	rationale: z.string().max(4_000).default(""),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ApplyUpdateInputSchema = z.object({
	proposal_id: z.string().trim().min(1),
	confirm_apply: z.boolean().default(false),
	poll_interval_ms: z.number().int().min(250).max(30_000).optional(),
	poll_timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
	sync_after_update: z.boolean().default(true),
});

export const AuditLogInputSchema = z.object({
	proposal_id: optionalNonEmptyString,
	action: optionalNonEmptyString,
	actor: optionalNonEmptyString,
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type GetDocumentInput = z.infer<typeof GetDocumentInputSchema>;
export type ProposeUpdateInput = z.infer<typeof ProposeUpdateInputSchema>;
export type ApplyUpdateInput = z.infer<typeof ApplyUpdateInputSchema>;
export type AuditLogInput = z.infer<typeof AuditLogInputSchema>;

type ProposalStatus =
	| "pending"
	| "applying"
	| "applied"
	| "rejected"
	| "conflict"
	| "failed";

type ProposalRow = {
	proposal_id: string;
	status: ProposalStatus;
	target_source: "builtin" | "r2" | "website";
	ai_search_instance: string | null;
	document_id: string | null;
	document_key: string;
	r2_key: string | null;
	expected_sha256: string;
	proposed_sha256: string;
	proposed_content: string;
	rationale: string;
	metadata_json: string | null;
	author: string;
	created_at: string;
	updated_at: string;
	applied_at: string | null;
	applied_by: string | null;
	apply_result_json: string | null;
};

type AuditEventRow = {
	id: number;
	event_id: string;
	proposal_id: string | null;
	action: string;
	actor: string;
	target_source: string | null;
	ai_search_instance: string | null;
	document_key: string | null;
	document_id: string | null;
	metadata_json: string | null;
	created_at: string;
};

export type DocumentResult = {
	source: "builtin" | "r2" | "website";
	instance?: string;
	document_id?: string;
	document_key?: string;
	r2_key?: string;
	url?: string;
	content: string;
	sha256: string;
	content_type?: string;
	size_bytes: number;
	item_info?: AiSearchItemInfo;
	r2_metadata?: {
		etag: string;
		uploaded?: string;
		http_metadata?: R2HTTPMetadata;
		custom_metadata?: Record<string, string>;
	};
};

export function identifyActor(request: Request, env: Env): Actor {
	const bearerToken = parseBearerToken(request.headers.get("Authorization"));
	if (env.AGENT_API_TOKEN) {
		if (!bearerToken || !constantTimeEqual(bearerToken, env.AGENT_API_TOKEN)) {
			throw new HttpError(401, "Unauthorized");
		}

		return {
			id: "agent-token",
			kind: "bearer",
		};
	}

	if (isEnabled(env.TRUST_CF_ACCESS_HEADERS)) {
		const accessActor = identifyCloudflareAccessActor(request);
		if (accessActor) {
			return accessActor;
		}
	}

	if (isEnabled(env.REQUIRE_AUTH)) {
		throw new HttpError(401, "Unauthorized");
	}

	return {
		id: "anonymous",
		kind: "anonymous",
	};
}

function identifyCloudflareAccessActor(request: Request): Actor | null {
	const accessEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
	if (accessEmail) {
		return {
			email: accessEmail,
			id: accessEmail,
			kind: "cloudflare-access",
		};
	}

	const accessServiceId =
		request.headers.get("Cf-Access-Authenticated-User-Service-Token-Id") ??
		request.headers.get("Cf-Access-Client-Id");
	if (accessServiceId) {
		return {
			id: `access-service:${accessServiceId}`,
			kind: "cloudflare-access",
		};
	}

	return null;
}

export async function searchDocuments(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = SearchInputSchema.parse(input);
	const aiSearchOptions = buildAiSearchOptions(parsed);
	const startedAt = Date.now();
	let singleInstanceId: string | undefined;

	const result = parsed.instance_ids
		? await env.AI_SEARCH.search({
				query: parsed.query,
				ai_search_options: {
					...aiSearchOptions,
					instance_ids: parsed.instance_ids,
				},
			})
		: await (async () => {
				const resolved = getAiSearchInstance(env, parsed.instance);
				singleInstanceId = resolved.id;
				return await resolved.instance.search({
					query: parsed.query,
					ai_search_options: aiSearchOptions,
				});
			})();

	await writeAudit(env, {
		action: "search",
		actor,
		ai_search_instance:
			singleInstanceId ?? parsed.instance_ids?.join(",") ?? null,
		metadata: {
			duration_ms: Date.now() - startedAt,
			query: parsed.query,
			result_count: result.chunks.length,
		},
	});

	return {
		search_query: result.search_query,
		result_count: result.chunks.length,
		chunks: result.chunks.map((chunk, index) => ({
			index,
			chunk_id: chunk.id,
			instance_id:
				"instance_id" in chunk ? chunk.instance_id : singleInstanceId,
			score: chunk.score,
			type: chunk.type,
			text: chunk.text,
			item_key: chunk.item.key,
			item_metadata: chunk.item.metadata ?? {},
			scoring_details: chunk.scoring_details ?? {},
		})),
		errors: "errors" in result ? (result.errors ?? []) : [],
	};
}

export async function getDocument(
	env: Env,
	actor: Actor,
	input: unknown,
	options: { audit?: boolean } = {},
): Promise<DocumentResult> {
	const parsed = GetDocumentInputSchema.parse(input);
	const audit = options.audit ?? true;

	if (parsed.source === "r2") {
		const result = await getR2Document(env, parsed);
		if (audit) {
			await writeAudit(env, {
				action: "get_document",
				actor,
				ai_search_instance: result.instance,
				target_source: "r2",
				document_key: result.r2_key,
				metadata: { size_bytes: result.size_bytes, sha256: result.sha256 },
			});
		}
		return result;
	}

	if (parsed.source === "website") {
		const result = await getWebsiteDocument(env, parsed);
		if (audit) {
			await writeAudit(env, {
				action: "get_document",
				actor,
				target_source: "website",
				document_key: result.url,
				metadata: { size_bytes: result.size_bytes, sha256: result.sha256 },
			});
		}
		return result;
	}

	const result = await getBuiltinDocument(env, parsed);
	if (audit) {
		await writeAudit(env, {
			action: "get_document",
			actor,
			target_source: "builtin",
			ai_search_instance: result.instance,
			document_id: result.document_id,
			document_key: result.document_key,
			metadata: { size_bytes: result.size_bytes, sha256: result.sha256 },
		});
	}
	return result;
}

export async function proposeUpdate(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = ProposeUpdateInputSchema.parse(input);
	const db = requireDb(env);
	const proposedBytes = byteLength(parsed.proposed_content);
	const maxBytes = getProposalMaxBytes(env);

	if (proposedBytes > maxBytes) {
		throw new HttpError(413, "Proposed content is too large.", {
			max_bytes: maxBytes,
			proposed_bytes: proposedBytes,
		});
	}

	const current = await getDocument(env, actor, parsed, { audit: false });
	if (current.source === "website") {
		throw new HttpError(
			400,
			"Website crawler sources are read-only. Store mutable documents in built-in storage or R2.",
		);
	}

	if (parsed.expected_sha256 !== current.sha256) {
		throw new HttpError(
			409,
			"The supplied expected_sha256 does not match the current document.",
			{
				current_sha256: current.sha256,
				expected_sha256: parsed.expected_sha256,
			},
		);
	}

	const proposedSha256 = await sha256Hex(parsed.proposed_content);
	if (proposedSha256 === current.sha256) {
		throw new HttpError(
			400,
			"Proposed content is identical to the current document.",
			{
				sha256: current.sha256,
			},
		);
	}

	const now = new Date().toISOString();
	const proposalId = crypto.randomUUID();
	const documentKey = requireDocumentKey(current);
	const metadataJson = parsed.metadata ? JSON.stringify(parsed.metadata) : null;

	await db
		.prepare(
			`INSERT INTO update_proposals (
				proposal_id, status, target_source, ai_search_instance, document_id,
				document_key, r2_key, expected_sha256, proposed_sha256,
				proposed_content, rationale, metadata_json, author,
				created_at, updated_at
			) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			proposalId,
			current.source,
			current.instance ?? null,
			current.document_id ?? null,
			documentKey,
			current.r2_key ?? null,
			current.sha256,
			proposedSha256,
			parsed.proposed_content,
			parsed.rationale,
			metadataJson,
			actor.id,
			now,
			now,
		)
		.run();

	await writeAudit(env, {
		action: "propose_update",
		actor,
		proposal_id: proposalId,
		target_source: current.source,
		ai_search_instance: current.instance,
		document_id: current.document_id,
		document_key: documentKey,
		metadata: {
			current_sha256: current.sha256,
			proposed_sha256: proposedSha256,
			proposed_bytes: proposedBytes,
		},
	});

	return {
		proposal_id: proposalId,
		status: "pending",
		target: {
			source: current.source,
			instance: current.instance,
			document_id: current.document_id,
			document_key: current.document_key,
			r2_key: current.r2_key,
		},
		current_sha256: current.sha256,
		proposed_sha256: proposedSha256,
		proposed_bytes: proposedBytes,
		apply_instruction:
			"Call apply_update with this proposal_id and confirm_apply=true after human approval.",
	};
}

export async function applyUpdate(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = ApplyUpdateInputSchema.parse(input);
	if (!parsed.confirm_apply) {
		throw new HttpError(400, "confirm_apply must be true to apply a proposal.");
	}

	const db = requireDb(env);
	const proposal = await getProposal(db, parsed.proposal_id);
	if (!proposal) {
		throw new HttpError(404, "Proposal not found.", {
			proposal_id: parsed.proposal_id,
		});
	}
	if (proposal.status !== "pending") {
		throw new HttpError(409, "Proposal is not pending.", {
			proposal_id: proposal.proposal_id,
			status: proposal.status,
		});
	}

	const current = await getDocument(
		env,
		actor,
		{
			source: proposal.target_source,
			instance: proposal.ai_search_instance ?? undefined,
			document_id: proposal.document_id ?? undefined,
			document_key: proposal.document_key,
			r2_key: proposal.r2_key ?? undefined,
		},
		{ audit: false },
	);

	if (current.sha256 !== proposal.expected_sha256) {
		const metadata = {
			current_sha256: current.sha256,
			expected_sha256: proposal.expected_sha256,
		};
		const markedConflict = await transitionProposalStatus(
			db,
			proposal.proposal_id,
			"pending",
			"conflict",
			actor.id,
			metadata,
		);
		if (!markedConflict) {
			const latest = await getProposal(db, proposal.proposal_id);
			throw new HttpError(409, "Proposal is not pending.", {
				proposal_id: proposal.proposal_id,
				status: latest?.status ?? "missing",
			});
		}
		await writeAudit(env, {
			action: "apply_update_conflict",
			actor,
			proposal_id: proposal.proposal_id,
			target_source: proposal.target_source,
			ai_search_instance: proposal.ai_search_instance,
			document_id: proposal.document_id,
			document_key: proposal.document_key,
			metadata,
		});
		throw new HttpError(
			409,
			"Current document content no longer matches the proposal baseline.",
			metadata,
		);
	}

	const appliedAt = new Date().toISOString();
	const claimed = await transitionProposalStatus(
		db,
		proposal.proposal_id,
		"pending",
		"applying",
		actor.id,
		{ started_at: appliedAt },
	);
	if (!claimed) {
		const latest = await getProposal(db, proposal.proposal_id);
		throw new HttpError(409, "Proposal is not pending.", {
			proposal_id: proposal.proposal_id,
			status: latest?.status ?? "missing",
		});
	}

	const metadata = parseJsonObject(proposal.metadata_json);
	let applyResult: Record<string, unknown>;
	try {
		applyResult =
			proposal.target_source === "r2"
				? await applyR2Update(
						env,
						proposal,
						parsed,
						actor,
						appliedAt,
						metadata,
						current,
					)
				: await applyBuiltinUpdate(
						env,
						proposal,
						parsed,
						actor,
						appliedAt,
						metadata,
						current,
					);

		const markedApplied = await markProposalApplied(
			db,
			proposal.proposal_id,
			appliedAt,
			actor.id,
			applyResult,
		);
		if (!markedApplied) {
			throw new HttpError(409, "Proposal changed while applying.", {
				proposal_id: proposal.proposal_id,
			});
		}
	} catch (error) {
		const problem = problemFromError(error);
		const terminalStatus: ProposalStatus =
			problem.status === 409 ? "conflict" : "failed";
		await transitionProposalStatus(
			db,
			proposal.proposal_id,
			"applying",
			terminalStatus,
			actor.id,
			{
				details: problem.details,
				error: problem.error,
				status: problem.status,
			},
		);
		await writeAudit(env, {
			action:
				terminalStatus === "conflict"
					? "apply_update_conflict"
					: "apply_update_failed",
			actor,
			proposal_id: proposal.proposal_id,
			target_source: proposal.target_source,
			ai_search_instance: proposal.ai_search_instance,
			document_id: proposal.document_id,
			document_key: proposal.document_key,
			metadata: {
				details: problem.details,
				error: problem.error,
				status: problem.status,
			},
		});
		throw error;
	}

	await writeAudit(env, {
		action: "apply_update",
		actor,
		proposal_id: proposal.proposal_id,
		target_source: proposal.target_source,
		ai_search_instance: proposal.ai_search_instance,
		document_id: proposal.document_id,
		document_key: proposal.document_key,
		metadata: {
			applied_sha256: proposal.proposed_sha256,
			result: applyResult,
		},
	});

	return {
		proposal_id: proposal.proposal_id,
		status: "applied",
		applied_at: appliedAt,
		applied_by: actor.id,
		applied_sha256: proposal.proposed_sha256,
		result: applyResult,
	};
}

export async function auditLog(
	env: Env,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = AuditLogInputSchema.parse(input);
	const db = requireDb(env);
	const query = buildAuditLogQuery(parsed);
	const result = await db
		.prepare(query.sql)
		.bind(...query.bindings)
		.all<AuditEventRow>();

	return {
		events: (result.results ?? []).map((row) => ({
			id: row.id,
			event_id: row.event_id,
			proposal_id: row.proposal_id,
			action: row.action,
			actor: row.actor,
			target_source: row.target_source,
			ai_search_instance: row.ai_search_instance,
			document_key: row.document_key,
			document_id: row.document_id,
			metadata: parseJsonObject(row.metadata_json),
			created_at: row.created_at,
		})),
		limit: parsed.limit,
		offset: parsed.offset,
	};
}

export function buildAuditLogQuery(input: AuditLogInput): {
	sql: string;
	bindings: Array<number | string>;
} {
	const filters: string[] = [];
	const bindings: Array<number | string> = [];

	if (input.proposal_id) {
		filters.push("proposal_id = ?");
		bindings.push(input.proposal_id);
	}
	if (input.action) {
		filters.push("action = ?");
		bindings.push(input.action);
	}
	if (input.actor) {
		filters.push("actor = ?");
		bindings.push(input.actor);
	}

	const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
	bindings.push(input.limit, input.offset);

	return {
		sql: `SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
		bindings,
	};
}

export function problemFromError(error: unknown): {
	status: number;
	error: string;
	details?: unknown;
} {
	if (error instanceof HttpError) {
		return {
			details: error.details,
			error: error.message,
			status: error.status,
		};
	}

	if (error instanceof z.ZodError) {
		return {
			details: error.issues,
			error: "Invalid request.",
			status: 400,
		};
	}

	return {
		error: error instanceof Error ? error.message : "Unknown error.",
		status: 500,
	};
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function getProposalMaxBytes(env: Env): number {
	return positiveIntegerEnv(env.PROPOSAL_MAX_BYTES, DEFAULT_PROPOSAL_MAX_BYTES);
}

function buildAiSearchOptions(input: SearchInput): AiSearchOptions {
	const retrieval: NonNullable<AiSearchOptions["retrieval"]> = {
		max_num_results: input.max_num_results,
		retrieval_type: input.retrieval_type,
	};

	if (input.match_threshold !== undefined) {
		retrieval.match_threshold = input.match_threshold;
	}
	if (input.context_expansion !== undefined) {
		retrieval.context_expansion = input.context_expansion;
	}
	if (input.metadata_only !== undefined) {
		retrieval.metadata_only = input.metadata_only;
	}
	if (input.filters) {
		retrieval.filters = input.filters as VectorizeVectorMetadataFilter;
	}

	const options: AiSearchOptions = { retrieval };
	if (input.query_rewrite !== undefined) {
		options.query_rewrite = { enabled: input.query_rewrite };
	}
	if (input.reranking !== undefined) {
		options.reranking = { enabled: input.reranking };
	}
	if (input.cache !== undefined) {
		options.cache = { enabled: input.cache };
	}
	return options;
}

function getAiSearchInstance(
	env: Env,
	instanceOverride?: string,
): { id: string; instance: AiSearchInstance } {
	const id = instanceOverride ?? env.DEFAULT_AI_SEARCH_INSTANCE;
	if (!id) {
		throw new HttpError(
			400,
			"AI Search instance is required. Pass instance or set DEFAULT_AI_SEARCH_INSTANCE.",
		);
	}
	return {
		id,
		instance: env.AI_SEARCH.get(id),
	};
}

async function getBuiltinDocument(
	env: Env,
	input: GetDocumentInput,
): Promise<DocumentResult> {
	const { id: instanceId, instance } = getAiSearchInstance(env, input.instance);
	let itemInfo: AiSearchItemInfo;

	if (input.document_id) {
		itemInfo = await instance.items.get(input.document_id).info();
		if (input.document_key && itemInfo.key !== input.document_key) {
			throw new HttpError(
				409,
				"document_id and document_key refer to different AI Search items.",
				{
					document_id: input.document_id,
					document_key: input.document_key,
					actual_key: itemInfo.key,
				},
			);
		}
	} else if (input.document_key) {
		itemInfo = await findAiSearchItemByKey(instance, input.document_key);
	} else {
		throw new HttpError(
			400,
			"document_id or document_key is required for built-in storage.",
		);
	}

	const content = await instance.items.get(itemInfo.id).download();
	const text = await new Response(content.body).text();

	return {
		content: text,
		content_type: content.contentType,
		document_id: itemInfo.id,
		document_key: itemInfo.key,
		instance: instanceId,
		item_info: itemInfo,
		sha256: await sha256Hex(text),
		size_bytes: byteLength(text),
		source: "builtin",
	};
}

async function findAiSearchItemByKey(
	instance: AiSearchInstance,
	key: string,
): Promise<AiSearchItemInfo> {
	let page = 1;
	for (;;) {
		const listed = await instance.items.list({
			page,
			per_page: 50,
			search: key,
		});
		const exact = listed.result.find((item) => item.key === key);
		if (exact) {
			return exact;
		}

		const info = listed.result_info;
		if (
			!info ||
			listed.result.length === 0 ||
			info.page * info.per_page >= info.total_count
		) {
			break;
		}
		page = info.page + 1;
	}

	throw new HttpError(404, "AI Search item not found by key.", {
		document_key: key,
	});
}

async function getR2Document(
	env: Env,
	input: GetDocumentInput,
): Promise<DocumentResult> {
	const key = input.r2_key ?? input.document_key;
	if (!key) {
		throw new HttpError(400, "r2_key or document_key is required for R2.");
	}
	if (!env.DOCS_BUCKET) {
		throw new HttpError(500, "DOCS_BUCKET binding is not configured.");
	}

	const object = await env.DOCS_BUCKET.get(key);
	if (!object) {
		throw new HttpError(404, "R2 object not found.", { r2_key: key });
	}

	const text = await object.text();
	return {
		content: text,
		content_type: object.httpMetadata?.contentType,
		document_key: key,
		instance: input.instance,
		r2_key: key,
		r2_metadata: {
			custom_metadata: object.customMetadata,
			etag: object.etag,
			http_metadata: object.httpMetadata,
			uploaded: object.uploaded?.toISOString(),
		},
		sha256: await sha256Hex(text),
		size_bytes: byteLength(text),
		source: "r2",
	};
}

async function getWebsiteDocument(
	env: Env,
	input: GetDocumentInput,
): Promise<DocumentResult> {
	if (!isEnabled(env.ALLOW_WEBSITE_FETCH)) {
		throw new HttpError(
			400,
			"Website crawler document fetch is disabled. Set ALLOW_WEBSITE_FETCH=true to fetch source URLs.",
		);
	}
	const url = input.url ?? input.document_key;
	if (!url) {
		throw new HttpError(
			400,
			"url or document_key is required for website sources.",
		);
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new HttpError(response.status, "Failed to fetch website document.", {
			url,
		});
	}
	const text = await response.text();
	return {
		content: text,
		content_type: response.headers.get("Content-Type") ?? undefined,
		document_key: url,
		sha256: await sha256Hex(text),
		size_bytes: byteLength(text),
		source: "website",
		url,
	};
}

async function applyBuiltinUpdate(
	env: Env,
	proposal: ProposalRow,
	input: ApplyUpdateInput,
	actor: Actor,
	appliedAt: string,
	metadata: Record<string, unknown>,
	current: DocumentResult,
): Promise<Record<string, unknown>> {
	const { instance } = getAiSearchInstance(
		env,
		proposal.ai_search_instance ?? undefined,
	);
	const existingMetadata = current.item_info?.metadata ?? {};
	const itemInfo = await instance.items.uploadAndPoll(
		proposal.document_key,
		proposal.proposed_content,
		{
			metadata: {
				...existingMetadata,
				...metadata,
				updated_at: appliedAt,
				updated_by: actor.id,
				update_proposal_id: proposal.proposal_id,
			},
			pollIntervalMs:
				input.poll_interval_ms ??
				positiveIntegerEnv(
					env.UPDATE_POLL_INTERVAL_MS,
					DEFAULT_UPDATE_POLL_INTERVAL_MS,
				),
			timeoutMs:
				input.poll_timeout_ms ??
				positiveIntegerEnv(
					env.UPDATE_POLL_TIMEOUT_MS,
					DEFAULT_UPDATE_POLL_TIMEOUT_MS,
				),
		},
	);
	if (itemInfo.status !== "completed") {
		throw new HttpError(502, "AI Search item indexing did not complete.", {
			error: itemInfo.error,
			item_id: itemInfo.id,
			item_key: itemInfo.key,
			status: itemInfo.status,
		});
	}

	return {
		item: itemInfo,
		source: "builtin",
	};
}

async function applyR2Update(
	env: Env,
	proposal: ProposalRow,
	input: ApplyUpdateInput,
	actor: Actor,
	appliedAt: string,
	metadata: Record<string, unknown>,
	current: DocumentResult,
): Promise<Record<string, unknown>> {
	if (!env.DOCS_BUCKET) {
		throw new HttpError(500, "DOCS_BUCKET binding is not configured.");
	}

	const key = proposal.r2_key ?? proposal.document_key;
	const expectedEtag = current.r2_metadata?.etag;
	if (!expectedEtag) {
		throw new HttpError(500, "R2 object ETag is not available.");
	}

	const putResult = await env.DOCS_BUCKET.put(key, proposal.proposed_content, {
		onlyIf: {
			etagMatches: expectedEtag,
		},
		customMetadata: {
			...current.r2_metadata?.custom_metadata,
			...stringifyMetadata(metadata),
			update_proposal_id: proposal.proposal_id,
			updated_at: appliedAt,
			updated_by: actor.id,
		},
		httpMetadata: current.r2_metadata?.http_metadata ?? {
			contentType: current.content_type ?? "text/markdown; charset=utf-8",
		},
	});
	if (!putResult) {
		throw new HttpError(
			409,
			"R2 object changed before update could be applied.",
			{
				expected_etag: expectedEtag,
				r2_key: key,
			},
		);
	}

	let syncJob: AiSearchJobInfo | undefined;
	if (input.sync_after_update && proposal.ai_search_instance) {
		syncJob = await env.AI_SEARCH.get(proposal.ai_search_instance).jobs.create({
			description: `Sync after update proposal ${proposal.proposal_id}`,
		});
	}

	return {
		indexing_note: syncJob
			? "Started an AI Search sync job for the R2-backed instance."
			: "R2 object was updated. AI Search will re-index on its configured sync interval unless a sync job is started separately.",
		r2_key: key,
		source: "r2",
		sync_job: syncJob,
	};
}

async function getProposal(
	db: D1Database,
	proposalId: string,
): Promise<ProposalRow | null> {
	return await db
		.prepare("SELECT * FROM update_proposals WHERE proposal_id = ?")
		.bind(proposalId)
		.first<ProposalRow>();
}

async function transitionProposalStatus(
	db: D1Database,
	proposalId: string,
	fromStatus: ProposalStatus,
	toStatus: ProposalStatus,
	actorId: string,
	metadata: Record<string, unknown>,
): Promise<boolean> {
	const now = new Date().toISOString();
	const result = await db
		.prepare(
			`UPDATE update_proposals
			 SET status = ?,
				 updated_at = ?,
				 applied_by = ?,
				 apply_result_json = ?
			 WHERE proposal_id = ? AND status = ?`,
		)
		.bind(
			toStatus,
			now,
			actorId,
			JSON.stringify(metadata),
			proposalId,
			fromStatus,
		)
		.run();
	return d1ChangeCount(result) === 1;
}

async function markProposalApplied(
	db: D1Database,
	proposalId: string,
	appliedAt: string,
	actorId: string,
	applyResult: Record<string, unknown>,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE update_proposals
			 SET status = 'applied',
				 applied_at = ?,
				 applied_by = ?,
				 updated_at = ?,
				 apply_result_json = ?
			 WHERE proposal_id = ? AND status = 'applying'`,
		)
		.bind(
			appliedAt,
			actorId,
			appliedAt,
			JSON.stringify(applyResult),
			proposalId,
		)
		.run();
	return d1ChangeCount(result) === 1;
}

async function writeAudit(
	env: Env,
	event: {
		action: string;
		actor: Actor;
		proposal_id?: string | null;
		target_source?: string | null;
		ai_search_instance?: string | null;
		document_key?: string | null;
		document_id?: string | null;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const db = requireDb(env);

	await db
		.prepare(
			`INSERT INTO audit_events (
			event_id, proposal_id, action, actor, target_source,
			ai_search_instance, document_key, document_id, metadata_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			event.proposal_id ?? null,
			event.action,
			event.actor.id,
			event.target_source ?? null,
			event.ai_search_instance ?? null,
			event.document_key ?? null,
			event.document_id ?? null,
			JSON.stringify(event.metadata ?? {}),
			new Date().toISOString(),
		)
		.run();
}

function requireDb(env: Env): D1Database {
	if (!env.DB) {
		throw new HttpError(500, "DB binding is not configured.");
	}
	return env.DB;
}

function requireDocumentKey(document: DocumentResult): string {
	const key = document.r2_key ?? document.document_key;
	if (!key) {
		throw new HttpError(
			400,
			"Resolved document does not have an updateable key.",
		);
	}
	return key;
}

function parseBearerToken(value: string | null): string | null {
	const match = value?.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

function d1ChangeCount(result: D1Result): number {
	const changes = result.meta.changes;
	return typeof changes === "number" ? changes : 0;
}

function stringifyMetadata(
	metadata: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(metadata).map(([key, value]) => [key, String(value)]),
	);
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

function isEnabled(value: string | undefined): boolean {
	return value?.toLowerCase() === "true" || value === "1";
}

function positiveIntegerEnv(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
	if (!value) {
		return {};
	}
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}
