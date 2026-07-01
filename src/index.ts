import {
	ApplyUpdateInputSchema,
	AuditLogInputSchema,
	type Env,
	GetDocumentInputSchema,
	ProposeUpdateInputSchema,
	SearchInputSchema,
	applyUpdate,
	auditLog,
	getDocument,
	HttpError,
	identifyActor,
	problemFromError,
	proposeUpdate,
	searchDocuments,
} from "./core";
import { createDocsMcpServer } from "./mcp";

const API_ROUTES = new Set([
	"/api/search",
	"/api/get_document",
	"/api/propose_update",
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
		return corsResponse(null, 204);
	}

	const url = new URL(request.url);

	try {
		if (url.pathname === "/") {
			return jsonResponse({
				name: "cf-ai-docs",
				mcp_endpoint: "/mcp",
				rest_endpoints: [...API_ROUTES].sort(),
				tools: [
					"search",
					"get_document",
					"propose_update",
					"apply_update",
					"audit_log",
				],
			});
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
			const actor = identifyActor(request, env);
			const server = createDocsMcpServer(env, actor);
			return await createMcpHandler(server, {
				authContext: { props: { actor } },
				corsOptions: {
					exposeHeaders: "Mcp-Session-Id, mcp-session-id",
					headers:
						"Authorization, Content-Type, Mcp-Protocol-Version, mcp-protocol-version, Mcp-Session-Id, mcp-session-id",
					methods: "GET, POST, DELETE, OPTIONS",
					origin: "*",
				},
				enableJsonResponse: true,
				route: "/mcp",
			})(request, env, ctx);
		}

		if (API_ROUTES.has(url.pathname)) {
			return await handleApiRoute(request, env, url.pathname);
		}

		return jsonResponse({ error: "Not found." }, 404);
	} catch (error) {
		const problem = problemFromError(error);
		return jsonResponse(problem, problem.status);
	}
}

function isBunRuntime(): boolean {
	return "Bun" in globalThis;
}

async function handleApiRoute(
	request: Request,
	env: Env,
	pathname: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return jsonResponse({ error: "Method not allowed." }, 405);
	}

	const actor = identifyActor(request, env);
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

function jsonResponse(body: unknown, status = 200): Response {
	return corsResponse(JSON.stringify(body, null, 2), status, {
		"Content-Type": "application/json; charset=utf-8",
	});
}

function corsResponse(
	body: BodyInit | null,
	status: number,
	headers: HeadersInit = {},
): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Access-Control-Allow-Origin", "*");
	responseHeaders.set(
		"Access-Control-Allow-Methods",
		"GET, POST, DELETE, OPTIONS",
	);
	responseHeaders.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, Mcp-Protocol-Version, mcp-protocol-version, Mcp-Session-Id, mcp-session-id",
	);
	responseHeaders.set(
		"Access-Control-Expose-Headers",
		"Mcp-Session-Id, mcp-session-id",
	);
	return new Response(body, {
		headers: responseHeaders,
		status,
	});
}
