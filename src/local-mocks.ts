import type { Env } from "./core";

export type LocalSeedDocument = {
	instance?: string;
	key: string;
	content: string;
	metadata?: Record<string, unknown>;
	source?: "builtin" | "r2";
};

type LocalItem = {
	id: string;
	key: string;
	content: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	status: AiSearchItemInfo["status"];
};

type LocalProposalRow = {
	proposal_id: string;
	status: string;
	operation: string;
	target_source: string;
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

type LocalAuditEventRow = {
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

export function createLocalMockEnv(
	options: { defaultInstance?: string; documents?: LocalSeedDocument[] } = {},
): Env {
	const defaultInstance = options.defaultInstance ?? "docs";
	const aiSearch = new LocalAiSearchNamespace(defaultInstance);
	const r2 = new LocalR2Bucket();

	for (const document of options.documents ?? defaultLocalDocuments) {
		if (document.source === "r2") {
			r2.seed(document.key, document.content, document.metadata);
			continue;
		}
		aiSearch
			.getLocalInstance(document.instance ?? defaultInstance)
			.seed(document.key, document.content, document.metadata);
	}

	return {
		AI_SEARCH: aiSearch as unknown as AiSearchNamespace,
		DB: new LocalD1Database() as unknown as D1Database,
		DEFAULT_AI_SEARCH_INSTANCE: defaultInstance,
		DOCS_BUCKET: r2 as unknown as R2Bucket,
		ENABLE_REST_API: "true",
		LOCAL_AUTH_BYPASS: "true",
		MCP_RESOURCE_URL: "http://localhost/mcp",
		OAUTH_AUTHORIZATION_SERVER: "http://localhost",
		PROPOSAL_MAX_BYTES: "2000000",
	};
}

export const defaultLocalDocuments: LocalSeedDocument[] = [
	{
		key: "runbooks/api-keys.md",
		content: `# API Key Rotation

Rotate API keys every 90 days.

1. Create a replacement key.
2. Deploy the new key to all services.
3. Verify traffic succeeds.
4. Revoke the old key.
`,
		metadata: { area: "runbooks", title: "API Key Rotation" },
	},
	{
		key: "architecture/rag-updates.md",
		content: `# RAG Documentation Updates

Agents must search first, fetch the full source document, then create an update proposal.
Applying a proposal requires explicit approval and a matching SHA-256 baseline.
`,
		metadata: { area: "architecture", title: "RAG Documentation Updates" },
	},
	{
		key: "r2/policies/access.md",
		content: `# Access Policy

Cloudflare Access protects the MCP Worker in deployed environments.
Local mock mode disables Access and uses in-memory bindings.
`,
		metadata: { area: "security", title: "Access Policy" },
		source: "r2",
	},
];

class LocalAiSearchNamespace {
	private readonly instances = new Map<string, LocalAiSearchInstance>();

	constructor(defaultInstance: string) {
		this.getLocalInstance(defaultInstance);
	}

	get(name: string): AiSearchInstance {
		return this.getLocalInstance(name) as unknown as AiSearchInstance;
	}

	getLocalInstance(name: string): LocalAiSearchInstance {
		let instance = this.instances.get(name);
		if (!instance) {
			instance = new LocalAiSearchInstance(name);
			this.instances.set(name, instance);
		}
		return instance;
	}

	async list(): Promise<AiSearchListResponse> {
		const result = [...this.instances.keys()].map((id) => ({
			id,
			status: "local",
			type: "builtin",
		}));
		return {
			result,
			result_info: {
				count: result.length,
				page: 1,
				per_page: result.length,
				total_count: result.length,
			},
		};
	}

	async create(config: AiSearchConfig): Promise<AiSearchInstance> {
		return this.get(config.id);
	}

	async delete(name: string): Promise<void> {
		this.instances.delete(name);
	}

	async search(
		params: AiSearchMultiSearchRequest,
	): Promise<AiSearchMultiSearchResponse> {
		const instanceIds = params.ai_search_options.instance_ids;
		const chunks = instanceIds.flatMap((instanceId) =>
			this.getLocalInstance(instanceId)
				.searchSync(
					params.query ?? params.messages.at(-1)?.content ?? "",
					params,
				)
				.chunks.map((chunk) => ({ ...chunk, instance_id: instanceId })),
		);

		return {
			chunks: chunks.sort((left, right) => right.score - left.score),
			search_query: params.query ?? "",
		};
	}
}

class LocalAiSearchInstance {
	private readonly docsById = new Map<string, LocalItem>();
	private readonly idsByKey = new Map<string, string>();
	readonly items = new LocalAiSearchItems(this);
	readonly jobs = new LocalAiSearchJobs();

	constructor(private readonly id: string) {}

	seed(
		key: string,
		content: string,
		metadata: Record<string, unknown> = {},
	): AiSearchItemInfo {
		return this.upsert(key, content, metadata);
	}

	async search(params: AiSearchSearchRequest): Promise<AiSearchSearchResponse> {
		return this.searchSync(
			params.query ?? params.messages.at(-1)?.content ?? "",
			params,
		);
	}

	searchSync(
		query: string,
		params?: { ai_search_options?: AiSearchOptions },
	): AiSearchSearchResponse {
		const maxResults =
			params?.ai_search_options?.retrieval?.max_num_results ?? 10;
		const threshold =
			params?.ai_search_options?.retrieval?.match_threshold ?? 0;
		const queryTerms = tokenize(query);

		const chunks = [...this.docsById.values()]
			.map((item) => {
				const score = scoreDocument(item, queryTerms);
				return {
					id: `chunk-${item.id}`,
					item,
					score,
					text: makeSnippet(item.content, queryTerms),
				};
			})
			.filter((result) => result.score >= threshold && result.score > 0)
			.sort((left, right) => right.score - left.score)
			.slice(0, maxResults)
			.map((result) => ({
				id: result.id,
				item: {
					key: result.item.key,
					metadata: result.item.metadata,
					timestamp: Date.parse(result.item.updatedAt),
				},
				score: result.score,
				text: result.text,
				type: "text",
			}));

		return {
			chunks,
			search_query: query,
		};
	}

	async chatCompletions(): Promise<AiSearchChatCompletionsResponse> {
		return {
			choices: [
				{
					message: {
						content: "Local AI Search mock does not generate answers.",
						role: "assistant",
					},
				},
			],
			chunks: [],
		};
	}

	async update(config: Partial<AiSearchConfig>): Promise<AiSearchInstanceInfo> {
		return {
			...config,
			id: this.id,
			status: "local",
			type: "builtin",
		};
	}

	async info(): Promise<AiSearchInstanceInfo> {
		return {
			id: this.id,
			status: "local",
			type: "builtin",
		};
	}

	async stats(): Promise<AiSearchStatsResponse> {
		return {
			completed: this.docsById.size,
			engine: {
				r2: {
					metadataSizeBytes: 0,
					objectCount: this.docsById.size,
					payloadSizeBytes: [...this.docsById.values()].reduce(
						(total, item) => total + byteLength(item.content),
						0,
					),
				},
			},
		};
	}

	upsert(
		key: string,
		content: string,
		metadata: Record<string, unknown> = {},
	): AiSearchItemInfo {
		const now = new Date().toISOString();
		const existingId = this.idsByKey.get(key);
		const id = existingId ?? crypto.randomUUID();
		const existing = existingId ? this.docsById.get(existingId) : undefined;
		const item: LocalItem = {
			content,
			createdAt: existing?.createdAt ?? now,
			id,
			key,
			metadata,
			status: "completed",
			updatedAt: now,
		};

		this.docsById.set(id, item);
		this.idsByKey.set(key, id);
		return this.toInfo(item);
	}

	getById(id: string): LocalItem | undefined {
		return this.docsById.get(id);
	}

	getByKey(key: string): LocalItem | undefined {
		const id = this.idsByKey.get(key);
		return id ? this.docsById.get(id) : undefined;
	}

	list(search?: string): LocalItem[] {
		const normalizedSearch = search?.toLowerCase();
		return [...this.docsById.values()].filter(
			(item) =>
				!normalizedSearch || item.key.toLowerCase().includes(normalizedSearch),
		);
	}

	deleteById(id: string): void {
		const item = this.docsById.get(id);
		if (item) {
			this.idsByKey.delete(item.key);
		}
		this.docsById.delete(id);
	}

	toInfo(item: LocalItem): AiSearchItemInfo {
		return {
			chunks_count: 1,
			created_at: item.createdAt,
			file_size: byteLength(item.content),
			id: item.id,
			key: item.key,
			last_seen_at: item.updatedAt,
			metadata: item.metadata,
			next_action: null,
			status: item.status,
		};
	}
}

class LocalAiSearchItems {
	constructor(private readonly instance: LocalAiSearchInstance) {}

	async list(
		params: AiSearchListItemsParams = {},
	): Promise<AiSearchListItemsResponse> {
		const page = params.page ?? 1;
		const perPage = params.per_page ?? 100;
		const all = this.instance.list(params.search);
		const start = (page - 1) * perPage;
		const result = all
			.slice(start, start + perPage)
			.map((item) => this.instance.toInfo(item));

		return {
			result,
			result_info: {
				count: result.length,
				page,
				per_page: perPage,
				total_count: all.length,
			},
		};
	}

	async upload(
		name: string,
		content: ReadableStream | Blob | string,
		options: AiSearchUploadItemOptions = {},
	): Promise<AiSearchItemInfo> {
		return this.instance.upsert(
			name,
			await readUploadContent(content),
			options.metadata,
		);
	}

	get(itemId: string): AiSearchItem {
		return new LocalAiSearchItem(
			this.instance,
			itemId,
		) as unknown as AiSearchItem;
	}

	async delete(itemId: string): Promise<void> {
		this.instance.deleteById(itemId);
	}
}

class LocalAiSearchItem {
	constructor(
		private readonly instance: LocalAiSearchInstance,
		private readonly itemId: string,
	) {}

	async info(): Promise<AiSearchItemInfo> {
		return this.instance.toInfo(this.requireItem());
	}

	async download(): Promise<AiSearchItemContentResult> {
		const item = this.requireItem();
		return {
			body: new Response(item.content).body ?? new ReadableStream(),
			contentType: "text/markdown; charset=utf-8",
			filename: item.key,
			size: byteLength(item.content),
		};
	}

	async sync(): Promise<AiSearchItemInfo> {
		return await this.info();
	}

	async logs(): Promise<AiSearchItemLogsResponse> {
		return {
			result: [
				{
					action: "LOCAL_MOCK",
					message: "Local mock item is already indexed.",
					timestamp: new Date().toISOString(),
				},
			],
			result_info: {
				count: 1,
				cursor: null,
				per_page: 1,
				truncated: false,
			},
		};
	}

	async chunks(
		params: AiSearchItemChunksParams = {},
	): Promise<AiSearchItemChunksResponse> {
		const item = this.requireItem();
		const limit = params.limit ?? 20;
		const offset = params.offset ?? 0;
		const result = [
			{
				end_byte: byteLength(item.content),
				id: `chunk-${item.id}`,
				item: {
					key: item.key,
					metadata: item.metadata,
				},
				start_byte: 0,
				text: item.content,
			},
		].slice(offset, offset + limit);

		return {
			result,
			result_info: {
				count: result.length,
				limit,
				offset,
				total: 1,
			},
		};
	}

	private requireItem(): LocalItem {
		const item = this.instance.getById(this.itemId);
		if (!item) {
			const error = new Error(`Local AI Search item not found: ${this.itemId}`);
			error.name = "AiSearchNotFoundError";
			throw error;
		}
		return item;
	}
}

class LocalAiSearchJobs {
	private readonly jobs: AiSearchJobInfo[] = [];

	async list(): Promise<AiSearchListJobsResponse> {
		return {
			result: this.jobs,
			result_info: {
				count: this.jobs.length,
				page: 1,
				per_page: this.jobs.length,
				total_count: this.jobs.length,
			},
		};
	}

	async create(params: AiSearchCreateJobParams = {}): Promise<AiSearchJobInfo> {
		const job = {
			description: params.description,
			ended_at: new Date().toISOString(),
			id: crypto.randomUUID(),
			source: "user",
			started_at: new Date().toISOString(),
		} satisfies AiSearchJobInfo;
		this.jobs.push(job);
		return job;
	}

	get(jobId: string): AiSearchJob {
		return {
			cancel: async () => this.requireJob(jobId),
			info: async () => this.requireJob(jobId),
			logs: async () => ({
				result: [],
				result_info: {
					count: 0,
					page: 1,
					per_page: 0,
					total_count: 0,
				},
			}),
		} as unknown as AiSearchJob;
	}

	private requireJob(jobId: string): AiSearchJobInfo {
		const job = this.jobs.find((candidate) => candidate.id === jobId);
		if (!job) {
			throw new Error(`Local AI Search job not found: ${jobId}`);
		}
		return job;
	}
}

class LocalR2Bucket {
	private readonly objects = new Map<string, LocalR2Object>();

	seed(
		key: string,
		content: string,
		metadata: Record<string, unknown> = {},
	): void {
		this.objects.set(
			key,
			new LocalR2Object(key, content, stringifyMetadata(metadata)),
		);
	}

	async get(key: string): Promise<LocalR2Object | null> {
		return this.objects.get(key) ?? null;
	}

	async put(
		key: string,
		content: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
		options: R2PutOptions = {},
	): Promise<R2Object | null> {
		const conditional = normalizeR2Conditional(options.onlyIf);
		if (
			conditional?.etagMatches &&
			this.objects.get(key)?.etag !== conditional.etagMatches
		) {
			return null;
		}

		const text = await readUploadContent(content);
		const object = new LocalR2Object(
			key,
			text,
			options.customMetadata ?? {},
			normalizeHttpMetadata(options.httpMetadata),
		);
		this.objects.set(key, object);
		return object as unknown as R2Object;
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}

class LocalR2Object {
	readonly etag = crypto.randomUUID();
	readonly uploaded = new Date();

	constructor(
		readonly key: string,
		private readonly content: string,
		readonly customMetadata: Record<string, string> = {},
		readonly httpMetadata: R2HTTPMetadata = {
			contentType: "text/markdown; charset=utf-8",
		},
	) {}

	async text(): Promise<string> {
		return this.content;
	}
}

class LocalD1Database {
	private readonly proposals = new Map<string, LocalProposalRow>();
	private readonly auditEvents: LocalAuditEventRow[] = [];
	private nextAuditId = 1;

	prepare(sql: string): LocalD1PreparedStatement {
		return new LocalD1PreparedStatement(this, sql);
	}

	run(sql: string, bindings: unknown[]): D1Result {
		let changes = 0;
		if (sql.includes("INSERT INTO update_proposals")) {
			const proposalId = asString(bindings, 0);
			const operation = asString(bindings, 1);
			const targetSource = asString(bindings, 2);
			const aiSearchInstance = asNullableString(bindings, 3);
			const documentId = asNullableString(bindings, 4);
			const documentKey = asString(bindings, 5);
			const r2Key = asNullableString(bindings, 6);
			const expectedSha256 = asString(bindings, 7);
			const proposedSha256 = asString(bindings, 8);
			const proposedContent = asString(bindings, 9);
			const rationale = asString(bindings, 10);
			const metadataJson = asNullableString(bindings, 11);
			const author = asString(bindings, 12);
			const createdAt = asString(bindings, 13);
			const updatedAt = asString(bindings, 14);

			this.proposals.set(proposalId, {
				ai_search_instance: aiSearchInstance,
				applied_at: null,
				applied_by: null,
				apply_result_json: null,
				author,
				created_at: createdAt,
				document_id: documentId,
				document_key: documentKey,
				expected_sha256: expectedSha256,
				metadata_json: metadataJson,
				operation,
				proposal_id: proposalId,
				proposed_content: proposedContent,
				proposed_sha256: proposedSha256,
				r2_key: r2Key,
				rationale,
				status: "pending",
				target_source: targetSource,
				updated_at: updatedAt,
			});
			changes = 1;
		} else if (
			sql.includes("UPDATE update_proposals") &&
			sql.includes("status = 'applied'")
		) {
			const appliedAt = asString(bindings, 0);
			const appliedBy = asString(bindings, 1);
			const updatedAt = asString(bindings, 2);
			const applyResultJson = asString(bindings, 3);
			const backfillDocumentId = asNullableString(bindings, 4);
			const proposalId = asString(bindings, 5);
			const proposal = this.proposals.get(proposalId);
			if (
				proposal &&
				(!sql.includes("status = 'applying'") || proposal.status === "applying")
			) {
				proposal.status = "applied";
				proposal.applied_at = appliedAt;
				proposal.applied_by = appliedBy;
				proposal.updated_at = updatedAt;
				proposal.apply_result_json = applyResultJson;
				if (!proposal.document_id && backfillDocumentId) {
					proposal.document_id = backfillDocumentId;
				}
				changes = 1;
			}
		} else if (
			sql.includes("UPDATE update_proposals") &&
			sql.includes("AND apply_result_json = ?")
		) {
			const newApplyResultJson = asString(bindings, 0);
			const proposalId = asString(bindings, 1);
			const expectedApplyResultJson = asNullableString(bindings, 2);
			const proposal = this.proposals.get(proposalId);
			if (proposal && proposal.apply_result_json === expectedApplyResultJson) {
				proposal.apply_result_json = newApplyResultJson;
				changes = 1;
			}
		} else if (sql.includes("UPDATE update_proposals")) {
			const status = asString(bindings, 0);
			const updatedAt = asString(bindings, 1);
			const appliedBy = asString(bindings, 2);
			const applyResultJson = asString(bindings, 3);
			const proposalId = asString(bindings, 4);
			const expectedStatus = sql.includes("AND status = ?")
				? asString(bindings, 5)
				: null;
			const proposal = this.proposals.get(proposalId);
			if (proposal && (!expectedStatus || proposal.status === expectedStatus)) {
				proposal.status = status;
				proposal.updated_at = updatedAt;
				proposal.applied_by = appliedBy;
				proposal.apply_result_json = applyResultJson;
				changes = 1;
			}
		} else if (sql.includes("INSERT INTO audit_events")) {
			const eventId = asString(bindings, 0);
			const proposalId = asNullableString(bindings, 1);
			const action = asString(bindings, 2);
			const actor = asString(bindings, 3);
			const targetSource = asNullableString(bindings, 4);
			const aiSearchInstance = asNullableString(bindings, 5);
			const documentKey = asNullableString(bindings, 6);
			const documentId = asNullableString(bindings, 7);
			const metadataJson = asNullableString(bindings, 8);
			const createdAt = asString(bindings, 9);
			this.auditEvents.push({
				action,
				actor,
				ai_search_instance: aiSearchInstance,
				created_at: createdAt,
				document_id: documentId,
				document_key: documentKey,
				event_id: eventId,
				id: this.nextAuditId,
				metadata_json: metadataJson,
				proposal_id: proposalId,
				target_source: targetSource,
			});
			this.nextAuditId += 1;
			changes = 1;
		}

		return {
			meta: { changes },
			success: true,
		} as D1Result;
	}

	first(sql: string, bindings: unknown[]): LocalProposalRow | null {
		if (sql.includes("SELECT * FROM update_proposals WHERE proposal_id = ?")) {
			const proposal = this.proposals.get(String(bindings[0]));
			return proposal ? { ...proposal } : null;
		}
		return null;
	}

	all(sql: string, bindings: unknown[]): LocalAuditEventRow[] {
		if (!sql.includes("SELECT * FROM audit_events")) {
			return [];
		}

		let bindingIndex = 0;
		let rows = [...this.auditEvents];
		if (sql.includes("proposal_id = ?")) {
			const proposalId = String(bindings[bindingIndex]);
			bindingIndex += 1;
			rows = rows.filter((row) => row.proposal_id === proposalId);
		}
		if (sql.includes("action = ?")) {
			const action = String(bindings[bindingIndex]);
			bindingIndex += 1;
			rows = rows.filter((row) => row.action === action);
		}
		if (sql.includes("actor = ?")) {
			const actor = String(bindings[bindingIndex]);
			bindingIndex += 1;
			rows = rows.filter((row) => row.actor === actor);
		}

		const limit = Number(bindings.at(-2) ?? 50);
		const offset = Number(bindings.at(-1) ?? 0);
		return rows
			.sort((left, right) => right.id - left.id)
			.slice(offset, offset + limit);
	}
}

class LocalD1PreparedStatement {
	private bindings: unknown[] = [];

	constructor(
		private readonly db: LocalD1Database,
		private readonly sql: string,
	) {}

	bind(...bindings: unknown[]): LocalD1PreparedStatement {
		this.bindings = bindings;
		return this;
	}

	async run(): Promise<D1Result> {
		return this.db.run(this.sql, this.bindings);
	}

	async first<T>(): Promise<T | null> {
		return this.db.first(this.sql, this.bindings) as T | null;
	}

	async all<T>(): Promise<D1Result<T>> {
		return {
			meta: {},
			results: this.db.all(this.sql, this.bindings) as T[],
			success: true,
		} as D1Result<T>;
	}
}

async function readUploadContent(
	content: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
): Promise<string> {
	if (typeof content === "string") {
		return content;
	}
	if (content instanceof Blob) {
		return await content.text();
	}
	if (content instanceof ReadableStream) {
		return await new Response(content).text();
	}
	if (content instanceof ArrayBuffer) {
		return new TextDecoder().decode(content);
	}
	const bytes = new Uint8Array(
		content.buffer,
		content.byteOffset,
		content.byteLength,
	);
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new TextDecoder().decode(copy);
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 1);
}

function scoreDocument(item: LocalItem, queryTerms: string[]): number {
	if (queryTerms.length === 0) {
		return 0;
	}

	const searchable =
		`${item.key}\n${item.content}\n${JSON.stringify(item.metadata)}`.toLowerCase();
	const matches = queryTerms.filter((term) => searchable.includes(term)).length;
	return matches / queryTerms.length;
}

function makeSnippet(content: string, queryTerms: string[]): string {
	const lowerContent = content.toLowerCase();
	const firstMatch = queryTerms
		.map((term) => lowerContent.indexOf(term))
		.filter((index) => index >= 0)
		.sort((left, right) => left - right)[0];
	const start = Math.max(0, (firstMatch ?? 0) - 120);
	return content.slice(start, start + 600);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function stringifyMetadata(
	metadata: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(metadata).map(([key, value]) => [key, String(value)]),
	);
}

function normalizeHttpMetadata(
	metadata: R2HTTPMetadata | Headers | undefined,
): R2HTTPMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	if (metadata instanceof Headers) {
		return {
			contentType: metadata.get("Content-Type") ?? undefined,
		};
	}
	return metadata;
}

function normalizeR2Conditional(
	conditional: R2Conditional | Headers | undefined,
): R2Conditional | undefined {
	if (!conditional) {
		return undefined;
	}
	if (conditional instanceof Headers) {
		const ifMatch = conditional.get("If-Match");
		return ifMatch ? { etagMatches: ifMatch.replace(/^"|"$/g, "") } : undefined;
	}
	return conditional;
}

function asString(bindings: unknown[], index: number): string {
	const value = bindings[index];
	if (value === undefined || value === null) {
		return "";
	}
	return String(value);
}

function asNullableString(bindings: unknown[], index: number): string | null {
	const value = bindings[index];
	if (value === undefined || value === null) {
		return null;
	}
	return String(value);
}
