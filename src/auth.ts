import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
	type Actor,
	type ActorRole,
	type Env,
	HttpError,
	isEnabled,
} from "./core";

export type ToolPermission = "read" | "write" | "apply" | "audit";

const MCP_ENDPOINT = "/mcp";
const PROTECTED_RESOURCE_METADATA_PREFIX =
	"/.well-known/oauth-protected-resource";
const SCOPES_BY_PERMISSION = {
	apply: "mcp:apply",
	audit: "mcp:audit",
	read: "mcp:read",
	write: "mcp:write",
} satisfies Record<ToolPermission, string>;
const ALL_SCOPES = [
	SCOPES_BY_PERMISSION.read,
	SCOPES_BY_PERMISSION.write,
	SCOPES_BY_PERMISSION.apply,
	SCOPES_BY_PERMISSION.audit,
];

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateRequest(
	request: Request,
	env: Env,
): Promise<Actor> {
	if (isEnabled(env.LOCAL_AUTH_BYPASS)) {
		return localActor(env);
	}

	const teamDomain = normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN);
	const audience = env.CF_ACCESS_AUD?.trim();
	if (!audience) {
		throw new HttpError(500, "CF_ACCESS_AUD is not configured.");
	}

	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) {
		throw authChallenge(request, env, "Missing Cloudflare Access JWT.");
	}

	try {
		const { payload } = await jwtVerify(token, getAccessJwks(teamDomain), {
			audience,
			issuer: teamDomain,
		});
		return actorFromAccessClaims(payload, env);
	} catch (error) {
		if (isJwksServerError(error)) {
			throw new HttpError(500, "Failed to verify Cloudflare Access JWT.", {
				cause: error instanceof Error ? error.message : "Unknown JWKS error.",
			});
		}
		throw authChallenge(request, env, "Invalid Cloudflare Access JWT.", {
			cause:
				error instanceof Error ? error.message : "Unknown verification error.",
		});
	}
}

export function requireActorPermission(
	actor: Actor,
	permission: ToolPermission,
) {
	if (!hasActorPermission(actor, permission)) {
		throw new HttpError(403, "Forbidden", {
			required_scope: SCOPES_BY_PERMISSION[permission],
			roles: actor.roles,
		});
	}
}

export function requireHttpPermission(
	request: Request,
	env: Env,
	actor: Actor,
	permission: ToolPermission,
) {
	if (!hasActorPermission(actor, permission)) {
		throw authChallenge(request, env, "Insufficient scope.", undefined, 403, [
			SCOPES_BY_PERMISSION[permission],
		]);
	}
}

export function hasActorPermission(
	actor: Actor,
	permission: ToolPermission,
): boolean {
	if (actor.roles.includes("admin")) {
		return true;
	}
	if (permission === "read") {
		return actor.roles.includes("read");
	}
	if (permission === "write") {
		return actor.roles.includes("editor");
	}
	return false;
}

export function buildProtectedResourceMetadata(
	request: Request,
	env: Env,
): OAuthProtectedResourceMetadata {
	const resource = getMcpResourceUrl(request, env);
	const authorizationServer = getAuthorizationServerUrl(resource, env);
	return {
		authorization_servers: [authorizationServer.href],
		bearer_methods_supported: ["header"],
		resource: resource.href,
		resource_name: "cf-ai-docs",
		scopes_supported: ALL_SCOPES,
	};
}

export function isProtectedResourceMetadataPath(pathname: string): boolean {
	return (
		pathname === PROTECTED_RESOURCE_METADATA_PREFIX ||
		pathname === `${PROTECTED_RESOURCE_METADATA_PREFIX}${MCP_ENDPOINT}`
	);
}

export function getAuthErrorHeaders(error: unknown): HeadersInit | undefined {
	return error instanceof HttpError ? error.headers : undefined;
}

export function getMcpCorsOptions(request: Request, env: Env) {
	return {
		exposeHeaders: "Mcp-Session-Id, mcp-session-id",
		headers:
			"Authorization, Content-Type, Accept, Mcp-Protocol-Version, mcp-protocol-version, Mcp-Session-Id, mcp-session-id, Last-Event-ID, last-event-id",
		methods: "GET, POST, DELETE, OPTIONS",
		origin: getCorsOrigin(request, env),
	};
}

export function getAllowedHosts(env: Env): string[] {
	const configured = parseList(env.MCP_ALLOWED_HOSTS);
	if (configured.length > 0) {
		return configured;
	}
	return [getConfiguredMcpResourceUrl(env).host];
}

export function getAllowedOrigins(env: Env): string[] {
	const configured = parseList(env.MCP_ALLOWED_ORIGINS);
	if (configured.length > 0) {
		return configured;
	}
	return [getConfiguredMcpResourceUrl(env).origin];
}

export function getCorsOrigin(request: Request, env: Env): string {
	const allowedOrigins = getAllowedOrigins(env);
	const requestOrigin = request.headers.get("Origin");
	if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
		return requestOrigin;
	}
	return allowedOrigins[0] ?? "*";
}

export function isRestApiEnabled(env: Env): boolean {
	return isEnabled(env.ENABLE_REST_API);
}

function actorFromAccessClaims(payload: JWTPayload, env: Env): Actor {
	const email = stringClaim(payload.email)?.toLowerCase();
	const subject = stringClaim(payload.sub);
	const serviceTokenId = stringClaim(payload.common_name);
	const id = email ?? subject ?? serviceTokenId ?? "cloudflare-access";
	const roles = email
		? rolesForEmail(email, env)
		: rolesForServiceToken(serviceTokenId, env);
	return {
		claims: sanitizeClaims(payload),
		email,
		id,
		kind: "cloudflare-access",
		roles,
		scopes: scopesForRoles(roles),
	};
}

function localActor(env: Env): Actor {
	const email = "local-dev@example.com";
	const roles = rolesForEmail(email, {
		...env,
		AUTH_ADMIN_EMAILS: env.AUTH_ADMIN_EMAILS ?? email,
	});
	return {
		email,
		id: email,
		kind: "local",
		roles,
		scopes: scopesForRoles(roles),
	};
}

function rolesForEmail(email: string | undefined, env: Env): ActorRole[] {
	const roles = new Set<ActorRole>(["read"]);
	if (!email) {
		return [...roles];
	}
	const editorEmails = parseEmailSet(env.AUTH_EDITOR_EMAILS);
	const adminEmails = parseEmailSet(env.AUTH_ADMIN_EMAILS);
	if (editorEmails.has(email)) {
		roles.add("editor");
	}
	if (adminEmails.has(email)) {
		roles.add("editor");
		roles.add("admin");
	}
	return [...roles];
}

function rolesForServiceToken(
	clientId: string | undefined,
	env: Env,
): ActorRole[] {
	const roles = new Set<ActorRole>(["read"]);
	if (!clientId) {
		return [...roles];
	}
	const normalized = clientId.toLowerCase();
	const editorTokens = parseEmailSet(env.AUTH_EDITOR_SERVICE_TOKENS);
	const adminTokens = parseEmailSet(env.AUTH_ADMIN_SERVICE_TOKENS);
	if (editorTokens.has(normalized)) {
		roles.add("editor");
	}
	if (adminTokens.has(normalized)) {
		roles.add("editor");
		roles.add("admin");
	}
	return [...roles];
}

function scopesForRoles(roles: ActorRole[]): string[] {
	const scopes = new Set<string>();
	if (roles.includes("read")) {
		scopes.add(SCOPES_BY_PERMISSION.read);
	}
	if (roles.includes("editor")) {
		scopes.add(SCOPES_BY_PERMISSION.write);
	}
	if (roles.includes("admin")) {
		scopes.add(SCOPES_BY_PERMISSION.apply);
		scopes.add(SCOPES_BY_PERMISSION.audit);
	}
	return [...scopes];
}

function authChallenge(
	request: Request,
	env: Env,
	message: string,
	details?: Record<string, unknown>,
	status = 401,
	scopes = [SCOPES_BY_PERMISSION.read],
): HttpError {
	return new HttpError(status, message, details, {
		"WWW-Authenticate": buildWwwAuthenticateHeader(request, env, scopes),
	});
}

function buildWwwAuthenticateHeader(
	request: Request,
	env: Env,
	scopes: string[],
): string {
	const parts = [
		`resource_metadata="${getProtectedResourceMetadataUrl(request, env).href}"`,
	];
	if (scopes.length > 0) {
		parts.push(`scope="${scopes.join(" ")}"`);
	}
	return `Bearer ${parts.join(", ")}`;
}

function getProtectedResourceMetadataUrl(request: Request, env: Env): URL {
	const resource = getMcpResourceUrl(request, env);
	return new URL(
		`${PROTECTED_RESOURCE_METADATA_PREFIX}${resource.pathname === "/" ? "" : resource.pathname}`,
		resource,
	);
}

function getMcpResourceUrl(request: Request, env: Env): URL {
	if (env.MCP_RESOURCE_URL?.trim()) {
		return getConfiguredMcpResourceUrl(env);
	}
	return new URL(MCP_ENDPOINT, request.url);
}

function getConfiguredMcpResourceUrl(env: Env): URL {
	if (!env.MCP_RESOURCE_URL?.trim()) {
		throw new HttpError(500, "MCP_RESOURCE_URL is not configured.");
	}
	const configured = new URL(env.MCP_RESOURCE_URL);
	configured.hash = "";
	configured.search = "";
	return configured;
}

function getAuthorizationServerUrl(resource: URL, env: Env): URL {
	const configured = env.OAUTH_AUTHORIZATION_SERVER?.trim();
	if (configured) {
		return new URL(configured);
	}
	return new URL("/", resource);
}

function getAccessJwks(
	teamDomain: string,
): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

function normalizeIssuer(value: string | undefined): string {
	if (!value?.trim()) {
		throw new HttpError(500, "CF_ACCESS_TEAM_DOMAIN is not configured.");
	}
	const url = new URL(value);
	url.hash = "";
	url.search = "";
	return url.href.replace(/\/$/, "");
}

function parseEmailSet(value: string | undefined): Set<string> {
	return new Set(parseList(value).map((email) => email.toLowerCase()));
}

function parseList(value: string | undefined): string[] {
	return (
		value
			?.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean) ?? []
	);
}

function stringClaim(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeClaims(payload: JWTPayload): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(payload).filter(([, value]) => value !== undefined),
	);
}

function isJwksServerError(error: unknown): boolean {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: undefined;
	if (
		code === "ERR_JWKS_INVALID" ||
		code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS" ||
		code === "ERR_JWKS_TIMEOUT"
	) {
		return true;
	}
	if (code === "ERR_JOSE_GENERIC" && error instanceof Error) {
		return (
			error.message.includes("JSON Web Key Set HTTP response") ||
			error.message.includes("JSON Web Key Set HTTP response as JSON")
		);
	}
	return false;
}
