import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireActorPermission } from "./auth";
import {
	type Actor,
	ApplyUpdateInputSchema,
	AuditLogInputSchema,
	CreateDocumentInputSchema,
	DeleteDocumentInputSchema,
	type Env,
	GetDocumentInputSchema,
	ProposeUpdateInputSchema,
	SearchInputSchema,
	applyUpdate,
	auditLog,
	createDocument,
	deleteDocument,
	getDocument,
	problemFromError,
	proposeUpdate,
	searchDocuments,
} from "./core";

export function createDocsMcpServer(env: Env, actor: Actor): McpServer {
	const server = new McpServer({
		name: "cf-ai-docs",
		version: "0.1.0",
	});

	server.registerTool(
		"search",
		{
			description:
				"Search Cloudflare AI Search documents and return relevant chunks with source keys.",
			inputSchema: SearchInputSchema,
			title: "Search documents",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "read");
				return searchDocuments(env, actor, input);
			}),
	);

	server.registerTool(
		"get_document",
		{
			description:
				"Fetch the full source document from AI Search built-in storage, R2, or an allowed website URL.",
			inputSchema: GetDocumentInputSchema,
			title: "Get document",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "read");
				return getDocument(env, actor, input);
			}),
	);

	server.registerTool(
		"propose_update",
		{
			description:
				"Create a pending full-document replacement proposal guarded by the current document SHA-256.",
			inputSchema: ProposeUpdateInputSchema,
			title: "Propose update",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "write");
				return proposeUpdate(env, actor, input);
			}),
	);

	server.registerTool(
		"create_document",
		{
			description:
				"Create a pending proposal for a brand-new document at a key that does not exist yet.",
			inputSchema: CreateDocumentInputSchema,
			title: "Create document",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "write");
				return createDocument(env, actor, input);
			}),
	);

	server.registerTool(
		"delete_document",
		{
			description:
				"Create a pending proposal to delete an existing document, guarded by the current document SHA-256.",
			inputSchema: DeleteDocumentInputSchema,
			title: "Delete document",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "write");
				return deleteDocument(env, actor, input);
			}),
	);

	server.registerTool(
		"apply_update",
		{
			description:
				"Apply a pending update proposal after explicit approval. Requires confirm_apply=true and rejects stale baselines.",
			inputSchema: ApplyUpdateInputSchema,
			title: "Apply update",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "apply");
				return applyUpdate(env, actor, input);
			}),
	);

	server.registerTool(
		"audit_log",
		{
			description:
				"Read audit events for searches, document reads, proposals, and applied updates.",
			inputSchema: AuditLogInputSchema,
			title: "Audit log",
		},
		async (input) =>
			asToolResult(() => {
				requireActorPermission(actor, "audit");
				return auditLog(env, input);
			}),
	);

	return server;
}

async function asToolResult(
	handler: () => Promise<unknown>,
): Promise<CallToolResult> {
	try {
		const result = await handler();
		return {
			content: [
				{
					text: JSON.stringify(result, null, 2),
					type: "text",
				},
			],
			structuredContent: asStructuredContent(result),
		};
	} catch (error) {
		const problem = problemFromError(error);
		return {
			content: [
				{
					text: JSON.stringify(problem, null, 2),
					type: "text",
				},
			],
			isError: true,
			structuredContent: problem,
		};
	}
}

function asStructuredContent(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: { value };
}
