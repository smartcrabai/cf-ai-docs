import { z } from "zod";

const DEFAULT_PROPOSAL_MAX_BYTES = 2_000_000;
const EMPTY_CONTENT_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// AI Search rejects uploads whose custom metadata contains these
// server-managed field names (invalid_metadata_format).
const RESERVED_AI_SEARCH_METADATA_FIELDS = new Set([
	"timestamp",
	"folder",
	"filename",
]);

export interface Env {
	AI_SEARCH: AiSearchNamespace;
	DB?: D1Database;
	DOCS_BUCKET?: R2Bucket;
	DEFAULT_AI_SEARCH_INSTANCE?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	MCP_RESOURCE_URL?: string;
	OAUTH_AUTHORIZATION_SERVER?: string;
	AUTH_EDITOR_EMAILS?: string;
	AUTH_ADMIN_EMAILS?: string;
	AUTH_EDITOR_SERVICE_TOKENS?: string;
	AUTH_ADMIN_SERVICE_TOKENS?: string;
	MCP_ALLOWED_ORIGINS?: string;
	MCP_ALLOWED_HOSTS?: string;
	ENABLE_REST_API?: string;
	LOCAL_AUTH_BYPASS?: string;
	PROPOSAL_MAX_BYTES?: string;
	ALLOW_WEBSITE_FETCH?: string;
}

export type ActorRole = "read" | "editor" | "admin";

export type Actor = {
	id: string;
	kind: "cloudflare-access" | "local";
	email?: string;
	roles: ActorRole[];
	scopes: string[];
	claims?: Record<string, unknown>;
};

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly details?: unknown,
		public readonly headers?: HeadersInit,
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

export const CreateDocumentInputSchema = z.object({
	source: z.enum(["builtin", "r2"]).default("builtin"),
	instance: optionalNonEmptyString,
	document_key: z.string().trim().min(1),
	r2_key: optionalNonEmptyString,
	proposed_content: z.string().min(1),
	rationale: z.string().max(4_000).default(""),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const DeleteDocumentInputSchema = z.object({
	source: z.enum(["builtin", "r2"]).default("builtin"),
	instance: optionalNonEmptyString,
	document_id: optionalNonEmptyString,
	document_key: optionalNonEmptyString,
	r2_key: optionalNonEmptyString,
	expected_sha256: z.string().trim().min(1),
	rationale: z.string().max(4_000).default(""),
});

export const ApplyUpdateInputSchema = z.object({
	proposal_id: z.string().trim().min(1),
	confirm_apply: z.boolean().default(false),
	sync_after_update: z.boolean().default(true),
});

export const AuditLogInputSchema = z.object({
	proposal_id: optionalNonEmptyString,
	action: optionalNonEmptyString,
	actor: optionalNonEmptyString,
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});

export const GetIndexStatusInputSchema = z.object({
	proposal_id: z.string().trim().min(1),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type GetDocumentInput = z.infer<typeof GetDocumentInputSchema>;
export type ProposeUpdateInput = z.infer<typeof ProposeUpdateInputSchema>;
export type CreateDocumentInput = z.infer<typeof CreateDocumentInputSchema>;
export type DeleteDocumentInput = z.infer<typeof DeleteDocumentInputSchema>;
export type ApplyUpdateInput = z.infer<typeof ApplyUpdateInputSchema>;
export type AuditLogInput = z.infer<typeof AuditLogInputSchema>;
export type GetIndexStatusInput = z.infer<typeof GetIndexStatusInputSchema>;

type ProposalStatus =
	| "pending"
	| "applying"
	| "applied"
	| "rejected"
	| "conflict"
	| "failed";

type ProposalOperation = "create" | "update" | "delete";

type ProposalRow = {
	proposal_id: string;
	status: ProposalStatus;
	operation: ProposalOperation;
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

async function tryGetDocument(
	env: Env,
	actor: Actor,
	input: GetDocumentInput,
): Promise<DocumentResult | null> {
	try {
		return await getDocument(env, actor, input, { audit: false });
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) {
			return null;
		}
		throw error;
	}
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

	const documentKey = requireDocumentKey(current);
	const metadataJson = parsed.metadata ? JSON.stringify(parsed.metadata) : null;

	const { proposalId } = await insertProposal(db, {
		aiSearchInstance: current.instance ?? null,
		documentId: current.document_id ?? null,
		documentKey,
		expectedSha256: current.sha256,
		operation: "update",
		proposedContent: parsed.proposed_content,
		proposedSha256,
		r2Key: current.r2_key ?? null,
		rationale: parsed.rationale,
		metadataJson,
		actorId: actor.id,
		targetSource: current.source,
	});

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

export async function createDocument(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = CreateDocumentInputSchema.parse(input);
	const db = requireDb(env);
	const proposedBytes = byteLength(parsed.proposed_content);
	const maxBytes = getProposalMaxBytes(env);

	if (proposedBytes > maxBytes) {
		throw new HttpError(413, "Proposed content is too large.", {
			max_bytes: maxBytes,
			proposed_bytes: proposedBytes,
		});
	}

	const existing = await tryGetDocument(env, actor, {
		document_key: parsed.document_key,
		instance: parsed.instance,
		r2_key: parsed.r2_key,
		source: parsed.source,
	});
	if (existing) {
		throw new HttpError(
			409,
			"A document already exists at this key. Use propose_update to modify it.",
			{
				current_sha256: existing.sha256,
				document_key: parsed.document_key,
			},
		);
	}

	const proposedSha256 = await sha256Hex(parsed.proposed_content);
	const metadataJson = parsed.metadata ? JSON.stringify(parsed.metadata) : null;

	const { proposalId } = await insertProposal(db, {
		aiSearchInstance: parsed.instance ?? null,
		documentId: null,
		documentKey: parsed.document_key,
		expectedSha256: EMPTY_CONTENT_SHA256,
		operation: "create",
		proposedContent: parsed.proposed_content,
		proposedSha256,
		r2Key: parsed.r2_key ?? null,
		rationale: parsed.rationale,
		metadataJson,
		actorId: actor.id,
		targetSource: parsed.source,
	});

	await writeAudit(env, {
		action: "create_document",
		actor,
		proposal_id: proposalId,
		target_source: parsed.source,
		ai_search_instance: parsed.instance,
		document_key: parsed.document_key,
		metadata: {
			proposed_sha256: proposedSha256,
			proposed_bytes: proposedBytes,
		},
	});

	return {
		proposal_id: proposalId,
		status: "pending",
		operation: "create",
		target: {
			source: parsed.source,
			instance: parsed.instance,
			document_key: parsed.document_key,
			r2_key: parsed.r2_key,
		},
		proposed_sha256: proposedSha256,
		proposed_bytes: proposedBytes,
		apply_instruction:
			"Call apply_update with this proposal_id and confirm_apply=true after human approval.",
	};
}

export async function deleteDocument(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = DeleteDocumentInputSchema.parse(input);
	const db = requireDb(env);
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

	const documentKey = requireDocumentKey(current);

	const { proposalId } = await insertProposal(db, {
		aiSearchInstance: current.instance ?? null,
		documentId: current.document_id ?? null,
		documentKey,
		expectedSha256: current.sha256,
		operation: "delete",
		proposedContent: "",
		proposedSha256: current.sha256,
		r2Key: current.r2_key ?? null,
		rationale: parsed.rationale,
		metadataJson: null,
		actorId: actor.id,
		targetSource: current.source,
	});

	await writeAudit(env, {
		action: "delete_document",
		actor,
		proposal_id: proposalId,
		target_source: current.source,
		ai_search_instance: current.instance,
		document_id: current.document_id,
		document_key: documentKey,
		metadata: {
			current_sha256: current.sha256,
		},
	});

	return {
		proposal_id: proposalId,
		status: "pending",
		operation: "delete",
		target: {
			source: current.source,
			instance: current.instance,
			document_id: current.document_id,
			document_key: current.document_key,
			r2_key: current.r2_key,
		},
		current_sha256: current.sha256,
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
	const proposal = await requireProposal(db, parsed.proposal_id);
	if (proposal.status !== "pending") {
		throw new HttpError(409, "Proposal is not pending.", {
			proposal_id: proposal.proposal_id,
			status: proposal.status,
		});
	}

	const documentRef = {
		source: proposal.target_source,
		instance: proposal.ai_search_instance ?? undefined,
		document_id: proposal.document_id ?? undefined,
		document_key: proposal.document_key,
		r2_key: proposal.r2_key ?? undefined,
	};
	const current =
		proposal.operation === "create"
			? await tryGetDocument(env, actor, documentRef)
			: await getDocument(env, actor, documentRef, { audit: false });
	const currentSha256 = current?.sha256 ?? EMPTY_CONTENT_SHA256;

	if (currentSha256 !== proposal.expected_sha256) {
		const metadata = {
			current_sha256: currentSha256,
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
	let appliedDocumentId = proposal.document_id;
	try {
		if (proposal.operation === "delete") {
			if (!current) {
				throw new HttpError(409, "Document to delete no longer exists.", {
					document_key: proposal.document_key,
				});
			}
			applyResult =
				proposal.target_source === "r2"
					? await applyR2Delete(env, proposal)
					: await applyBuiltinDelete(env, proposal, current);
		} else {
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
							actor,
							appliedAt,
							metadata,
							current,
						);
		}

		appliedDocumentId =
			proposal.document_id ?? extractUploadedItemId(applyResult) ?? null;
		const markedApplied = await markProposalApplied(
			db,
			proposal.proposal_id,
			appliedAt,
			actor.id,
			applyResult,
			appliedDocumentId,
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
		document_id: appliedDocumentId,
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

export async function getIndexStatus(
	env: Env,
	actor: Actor,
	input: unknown,
): Promise<Record<string, unknown>> {
	const parsed = GetIndexStatusInputSchema.parse(input);
	const db = requireDb(env);
	const proposal = await requireProposal(db, parsed.proposal_id);

	const base = {
		proposal_id: proposal.proposal_id,
		proposal_status: proposal.status,
		operation: proposal.operation,
		target_source: proposal.target_source,
	};

	if (proposal.status !== "applied" || proposal.operation === "delete") {
		return { ...base, note: buildIndexStatusNote(proposal) };
	}

	const applyResult = parseJsonObject(proposal.apply_result_json);

	if (proposal.target_source === "builtin") {
		const { instance } = getAiSearchInstance(
			env,
			resolveAiSearchInstanceId(proposal, applyResult),
		);
		const itemId = await resolveBuiltinItemId(instance, proposal, applyResult);
		let info: AiSearchItemInfo;
		try {
			info = await instance.items.get(itemId).info();
		} catch (error) {
			if (isAiSearchNotFoundError(error)) {
				throw new HttpError(
					404,
					"AI Search item not found for this proposal.",
					{
						document_id: itemId,
						proposal_id: proposal.proposal_id,
					},
				);
			}
			throw new HttpError(502, "AI Search item status lookup failed.", {
				cause: String(error),
			});
		}

		// Anything other than queued/running is a terminal outcome. Only
		// "error" is reported as index_failed (see recordIndexTerminalStatusOnce);
		// completed/skipped/outdated are all reported as index_completed since
		// AI Search has stopped actively processing the item either way.
		if (info.status !== "queued" && info.status !== "running") {
			await recordIndexTerminalStatusOnce(
				db,
				env,
				actor,
				proposal,
				applyResult,
				info,
			);
		}

		return {
			...base,
			indexing: {
				document_id: info.id,
				key: info.key,
				status: info.status,
				error: info.error,
			},
		};
	}

	if (proposal.target_source === "r2") {
		const syncJob = applyResult.sync_job as { id?: unknown } | undefined;
		const syncJobId = typeof syncJob?.id === "string" ? syncJob.id : undefined;
		if (syncJobId && proposal.ai_search_instance) {
			const { instance } = getAiSearchInstance(
				env,
				proposal.ai_search_instance,
			);
			let jobInfo: AiSearchJobInfo;
			try {
				jobInfo = await instance.jobs.get(syncJobId).info();
			} catch (error) {
				if (isAiSearchNotFoundError(error)) {
					throw new HttpError(
						404,
						"AI Search sync job not found for this proposal.",
						{
							job_id: syncJobId,
							proposal_id: proposal.proposal_id,
						},
					);
				}
				throw new HttpError(502, "AI Search sync job status lookup failed.", {
					cause: String(error),
				});
			}
			return { ...base, indexing: jobInfo };
		}
		return {
			...base,
			note: "No sync job was recorded for this update. AI Search re-indexes R2-backed instances on their configured sync schedule.",
		};
	}

	return base;
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

// Resolves the AI Search instance to use for a builtin proposal with the
// same instance the write was applied against: proposal.ai_search_instance
// (set at proposal time) first, then the instance recorded in apply_result
// at apply time, and only then the caller's current default. This avoids a
// status check drifting to a different instance if DEFAULT_AI_SEARCH_INSTANCE
// changes between apply_update and get_index_status.
function resolveAiSearchInstanceId(
	proposal: ProposalRow,
	applyResult: Record<string, unknown>,
): string | undefined {
	if (proposal.ai_search_instance) {
		return proposal.ai_search_instance;
	}
	return typeof applyResult.ai_search_instance === "string"
		? applyResult.ai_search_instance
		: undefined;
}

async function resolveBuiltinItemId(
	instance: AiSearchInstance,
	proposal: ProposalRow,
	applyResult: Record<string, unknown>,
): Promise<string> {
	if (proposal.document_id) {
		return proposal.document_id;
	}
	const uploadedId = extractUploadedItemId(applyResult);
	if (uploadedId) {
		return uploadedId;
	}
	try {
		const found = await findAiSearchItemByKey(instance, proposal.document_key);
		return found.id;
	} catch (error) {
		// findAiSearchItemByKey's own "not found after a full scan" HttpError
		// is already a clean 404 — pass it through unchanged.
		if (error instanceof HttpError) {
			throw error;
		}
		if (isAiSearchNotFoundError(error)) {
			throw new HttpError(404, "AI Search item not found for this proposal.", {
				document_key: proposal.document_key,
				proposal_id: proposal.proposal_id,
			});
		}
		throw new HttpError(502, "AI Search item lookup by key failed.", {
			cause: String(error),
		});
	}
}

function extractUploadedItemId(
	applyResult: Record<string, unknown>,
): string | undefined {
	const resultItem = applyResult.item;
	if (
		resultItem &&
		typeof resultItem === "object" &&
		"id" in resultItem &&
		typeof (resultItem as { id?: unknown }).id === "string"
	) {
		return (resultItem as { id: string }).id;
	}
	return undefined;
}

const NOT_FOUND_MESSAGE_PATTERN = /not[ _-]?found/i;

// The AI Search binding's not-found error is not documented to always be
// named "AiSearchNotFoundError", so also treat a "not found"-ish message as
// not-found. A misclassification here still fails safe: anything not
// recognized as not-found falls back to a 502 with the original cause.
function isAiSearchNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return (
		error.name === "AiSearchNotFoundError" ||
		NOT_FOUND_MESSAGE_PATTERN.test(error.message)
	);
}

// Writes an index_completed/index_failed audit event the first time a
// builtin item's indexing is observed to have reached a terminal state
// (anything other than queued/running). Only "error" is reported as
// index_failed; completed/skipped/outdated are all index_completed, since
// they all mean AI Search stopped actively processing the item. Subsequent
// polls that observe the same terminal status are no-ops.
async function recordIndexTerminalStatusOnce(
	db: D1Database,
	env: Env,
	actor: Actor,
	proposal: ProposalRow,
	applyResult: Record<string, unknown>,
	info: AiSearchItemInfo,
): Promise<void> {
	const terminalStatus = info.status;
	if (applyResult.indexing_terminal_status === terminalStatus) {
		return;
	}

	const updatedApplyResult = {
		...applyResult,
		indexing_terminal_status: terminalStatus,
	};
	const result = await db
		.prepare(
			`UPDATE update_proposals
			 SET apply_result_json = ?
			 WHERE proposal_id = ? AND apply_result_json = ?`,
		)
		.bind(
			JSON.stringify(updatedApplyResult),
			proposal.proposal_id,
			proposal.apply_result_json,
		)
		.run();
	if (d1ChangeCount(result) !== 1) {
		// Another concurrent poll already recorded this terminal status.
		return;
	}

	await writeAudit(env, {
		action: terminalStatus === "error" ? "index_failed" : "index_completed",
		actor,
		proposal_id: proposal.proposal_id,
		target_source: proposal.target_source,
		ai_search_instance: proposal.ai_search_instance,
		document_id: info.id,
		document_key: proposal.document_key,
		metadata: {
			status: terminalStatus,
			error: info.error,
			// The audit actor is whoever polled get_index_status, not who
			// applied the proposal; keep the applier traceable here too.
			applied_by: proposal.applied_by,
		},
	});
}

function buildIndexStatusNote(proposal: ProposalRow): string {
	if (proposal.operation === "delete" && proposal.status === "applied") {
		return "This proposal deleted the document. There is no indexing status to check.";
	}
	switch (proposal.status) {
		case "pending":
			return "Proposal has not been applied yet.";
		case "applying":
			return "Proposal is currently being applied.";
		case "rejected":
			return "Proposal was rejected and was never applied.";
		case "conflict":
			return "Proposal application hit a conflict and was not applied.";
		case "failed":
			return "Proposal application failed and was not applied.";
		default:
			return "Proposal has not been applied.";
	}
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
	actor: Actor,
	appliedAt: string,
	metadata: Record<string, unknown>,
	current: DocumentResult | null,
): Promise<Record<string, unknown>> {
	const { id: instanceId, instance } = getAiSearchInstance(
		env,
		proposal.ai_search_instance ?? undefined,
	);
	const existingMetadata = sanitizeAiSearchMetadata(
		current?.item_info?.metadata,
	);
	const itemInfo = await instance.items.upload(
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
		},
	);
	if (itemInfo.status === "error") {
		throw new HttpError(502, "AI Search rejected the uploaded item.", {
			error: itemInfo.error,
			item_id: itemInfo.id,
			key: itemInfo.key,
			status: itemInfo.status,
		});
	}

	return {
		source: "builtin",
		item: itemInfo,
		ai_search_instance: instanceId,
		indexing_status: itemInfo.status,
		indexing_note:
			"Indexing continues asynchronously. Check progress with get_index_status.",
	};
}

async function applyR2Update(
	env: Env,
	proposal: ProposalRow,
	input: ApplyUpdateInput,
	actor: Actor,
	appliedAt: string,
	metadata: Record<string, unknown>,
	current: DocumentResult | null,
): Promise<Record<string, unknown>> {
	if (!env.DOCS_BUCKET) {
		throw new HttpError(500, "DOCS_BUCKET binding is not configured.");
	}

	const key = proposal.r2_key ?? proposal.document_key;
	const expectedEtag = current?.r2_metadata?.etag;
	if (current && !expectedEtag) {
		throw new HttpError(500, "R2 object ETag is not available.");
	}

	const putResult = await env.DOCS_BUCKET.put(key, proposal.proposed_content, {
		onlyIf: expectedEtag ? { etagMatches: expectedEtag } : undefined,
		customMetadata: {
			...current?.r2_metadata?.custom_metadata,
			...stringifyMetadata(metadata),
			update_proposal_id: proposal.proposal_id,
			updated_at: appliedAt,
			updated_by: actor.id,
		},
		httpMetadata: current?.r2_metadata?.http_metadata ?? {
			contentType: current?.content_type ?? "text/markdown; charset=utf-8",
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

async function applyBuiltinDelete(
	env: Env,
	proposal: ProposalRow,
	current: DocumentResult,
): Promise<Record<string, unknown>> {
	const { instance } = getAiSearchInstance(
		env,
		proposal.ai_search_instance ?? undefined,
	);
	const documentId = current.document_id;
	if (!documentId) {
		throw new HttpError(500, "Document ID is not available for deletion.");
	}
	await instance.items.delete(documentId);

	return {
		deleted: true,
		document_id: documentId,
		document_key: proposal.document_key,
		source: "builtin",
	};
}

async function applyR2Delete(
	env: Env,
	proposal: ProposalRow,
): Promise<Record<string, unknown>> {
	if (!env.DOCS_BUCKET) {
		throw new HttpError(500, "DOCS_BUCKET binding is not configured.");
	}
	const key = proposal.r2_key ?? proposal.document_key;
	await env.DOCS_BUCKET.delete(key);

	return {
		deleted: true,
		r2_key: key,
		source: "r2",
	};
}

async function insertProposal(
	db: D1Database,
	params: {
		operation: ProposalOperation;
		targetSource: "builtin" | "r2" | "website";
		aiSearchInstance: string | null;
		documentId: string | null;
		documentKey: string;
		r2Key: string | null;
		expectedSha256: string;
		proposedSha256: string;
		proposedContent: string;
		rationale: string;
		metadataJson: string | null;
		actorId: string;
	},
): Promise<{ proposalId: string }> {
	const now = new Date().toISOString();
	const proposalId = crypto.randomUUID();

	await db
		.prepare(
			`INSERT INTO update_proposals (
				proposal_id, status, operation, target_source, ai_search_instance, document_id,
				document_key, r2_key, expected_sha256, proposed_sha256,
				proposed_content, rationale, metadata_json, author,
				created_at, updated_at
			) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			proposalId,
			params.operation,
			params.targetSource,
			params.aiSearchInstance,
			params.documentId,
			params.documentKey,
			params.r2Key,
			params.expectedSha256,
			params.proposedSha256,
			params.proposedContent,
			params.rationale,
			params.metadataJson,
			params.actorId,
			now,
			now,
		)
		.run();

	return { proposalId };
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

async function requireProposal(
	db: D1Database,
	proposalId: string,
): Promise<ProposalRow> {
	const proposal = await getProposal(db, proposalId);
	if (!proposal) {
		throw new HttpError(404, "Proposal not found.", {
			proposal_id: proposalId,
		});
	}
	return proposal;
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
	backfillDocumentId: string | null,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE update_proposals
			 SET status = 'applied',
				 applied_at = ?,
				 applied_by = ?,
				 updated_at = ?,
				 apply_result_json = ?,
				 document_id = COALESCE(document_id, ?)
			 WHERE proposal_id = ? AND status = 'applying'`,
		)
		.bind(
			appliedAt,
			actorId,
			appliedAt,
			JSON.stringify(applyResult),
			backfillDocumentId,
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

function sanitizeAiSearchMetadata(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!metadata) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(metadata).filter(
			([key]) => !RESERVED_AI_SEARCH_METADATA_FIELDS.has(key),
		),
	);
}

export function isEnabled(value: string | undefined): boolean {
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
