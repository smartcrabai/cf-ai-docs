import {
	ApplyUpdateInputSchema,
	AuditLogInputSchema,
	CreateDocumentInputSchema,
	DeleteDocumentInputSchema,
	type Actor,
	type Env,
	GetDocumentInputSchema,
	ProposeUpdateInputSchema,
	SearchInputSchema,
	applyUpdate,
	auditLog,
	createDocument,
	deleteDocument,
	getDocument,
	HttpError,
	problemFromError,
	proposeUpdate,
	searchDocuments,
} from "./core";
import { createDocsMcpServer } from "./mcp";
import {
	authenticateRequest,
	buildProtectedResourceMetadata,
	getAllowedHosts,
	getAllowedOrigins,
	getAuthErrorHeaders,
	getCorsOrigin,
	getMcpCorsOptions,
	isProtectedResourceMetadataPath,
	isRestApiEnabled,
	requireHttpPermission,
	type ToolPermission,
} from "./auth";

const API_ROUTES = new Set([
	"/api/search",
	"/api/get_document",
	"/api/propose_update",
	"/api/create_document",
	"/api/delete_document",
	"/api/apply_update",
	"/api/audit_log",
]);

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		return await handleRequest(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export async function handleRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return corsResponse(null, 204, {}, request, env);
	}

	const url = new URL(request.url);

	try {
		if (url.pathname === "/") {
			return jsonResponse({
				name: "cf-ai-docs",
				mcp_endpoint: "/mcp",
				rest_endpoints: isRestApiEnabled(env) ? [...API_ROUTES].sort() : [],
				tools: [
					"search",
					"get_document",
					"propose_update",
					"create_document",
					"delete_document",
					"apply_update",
					"audit_log",
				],
			});
		}

		if (isProtectedResourceMetadataPath(url.pathname)) {
			return jsonResponse(buildProtectedResourceMetadata(request, env));
		}

		if (url.pathname === "/health") {
			return jsonResponse({
				ok: true,
				time: new Date().toISOString(),
			});
		}

		if (url.pathname === "/mcp") {
			if (isBunRuntime()) {
				throw new HttpError(
					501,
					"The /mcp endpoint requires the Cloudflare Workers runtime. Use dev:mock for REST behavior checks, or use wrangler/deploy for MCP runtime checks.",
				);
			}
			const { createMcpHandler } = await import("agents/mcp");
			const actor = await authenticateRequest(request, env);
			const server = createDocsMcpServer(env, actor);
			return await createMcpHandler(
				server,
				buildMcpHandlerOptions(request, env, actor),
			)(request, env, ctx);
		}

		if (API_ROUTES.has(url.pathname)) {
			if (!isRestApiEnabled(env)) {
				return jsonResponse({ error: "Not found." }, 404);
			}
			return await handleApiRoute(request, env, url.pathname);
		}

		return jsonResponse({ error: "Not found." }, 404);
	} catch (error) {
		const problem = problemFromError(error);
		return jsonResponse(
			problem,
			problem.status,
			getAuthErrorHeaders(error),
			request,
			env,
		);
	}
}

function isBunRuntime(): boolean {
	return "Bun" in globalThis;
}

export function buildMcpHandlerOptions(
	request: Request,
	env: Env,
	actor: Actor,
) {
	return {
		allowedHosts: getAllowedHosts(env),
		allowedOrigins: getAllowedOrigins(env),
		authContext: { props: { actor } },
		corsOptions: getMcpCorsOptions(request, env),
		enableDnsRebindingProtection: true,
		route: "/mcp",
	};
}

async function handleApiRoute(
	request: Request,
	env: Env,
	pathname: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return jsonResponse({ error: "Method not allowed." }, 405);
	}

	const actor = await authenticateRequest(request, env);
	requireHttpPermission(request, env, actor, apiRoutePermission(pathname));
	const body = await readJsonBody(request);

	switch (pathname) {
		case "/api/search":
			return jsonResponse(
				await searchDocuments(env, actor, SearchInputSchema.parse(body)),
			);
		case "/api/get_document":
			return jsonResponse(
				await getDocument(env, actor, GetDocumentInputSchema.parse(body)),
			);
		case "/api/propose_update":
			return jsonResponse(
				await proposeUpdate(env, actor, ProposeUpdateInputSchema.parse(body)),
			);
		case "/api/create_document":
			return jsonResponse(
				await createDocument(env, actor, CreateDocumentInputSchema.parse(body)),
			);
		case "/api/delete_document":
			return jsonResponse(
				await deleteDocument(env, actor, DeleteDocumentInputSchema.parse(body)),
			);
		case "/api/apply_update":
			return jsonResponse(
				await applyUpdate(env, actor, ApplyUpdateInputSchema.parse(body)),
			);
		case "/api/audit_log":
			return jsonResponse(await auditLog(env, AuditLogInputSchema.parse(body)));
		default:
			return jsonResponse({ error: "Not found." }, 404);
	}
}

function apiRoutePermission(pathname: string): ToolPermission {
	switch (pathname) {
		case "/api/search":
		case "/api/get_document":
			return "read";
		case "/api/propose_update":
		case "/api/create_document":
		case "/api/delete_document":
			return "write";
		case "/api/apply_update":
			return "apply";
		case "/api/audit_log":
			return "audit";
		default:
			return "read";
	}
}

async function readJsonBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text.trim()) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "Request body must be valid JSON.");
	}
}

function jsonResponse(
	body: unknown,
	status = 200,
	headers: HeadersInit = {},
	request?: Request,
	env?: Env,
): Response {
	return corsResponse(
		JSON.stringify(body, null, 2),
		status,
		{
			"Content-Type": "application/json; charset=utf-8",
			...headers,
		},
		request,
		env,
	);
}

function corsResponse(
	body: BodyInit | null,
	status: number,
	headers: HeadersInit = {},
	request?: Request,
	env?: Env,
): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set(
		"Access-Control-Allow-Origin",
		request && env ? getCorsOrigin(request, env) : "*",
	);
	responseHeaders.set(
		"Access-Control-Allow-Methods",
		"GET, POST, DELETE, OPTIONS",
	);
	responseHeaders.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, Accept, Mcp-Protocol-Version, mcp-protocol-version, Mcp-Session-Id, mcp-session-id, Last-Event-ID, last-event-id",
	);
	responseHeaders.set(
		"Access-Control-Expose-Headers",
		"Mcp-Session-Id, mcp-session-id, WWW-Authenticate",
	);
	return new Response(body, {
		headers: responseHeaders,
		status,
	});
}
