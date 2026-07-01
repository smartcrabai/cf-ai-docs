import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import {
	authenticateRequest,
	buildProtectedResourceMetadata,
	getAllowedHosts,
	getAllowedOrigins,
	requireActorPermission,
	requireHttpPermission,
} from "./auth";
import { type Env, HttpError } from "./core";

const baseEnv = {
	AI_SEARCH: undefined as unknown as Env["AI_SEARCH"],
	CF_ACCESS_AUD: "cf-ai-docs-aud",
	MCP_RESOURCE_URL: "https://docs.example.com/mcp",
	OAUTH_AUTHORIZATION_SERVER: "https://docs.example.com",
} satisfies Env;

describe("Cloudflare Access authentication", () => {
	test("verifies Access JWTs and assigns configured roles", async () => {
		const { env, jwks, token } = await makeAccessToken("admin@example.com");
		const actor = await withMockAccessCerts(env, jwks, () =>
			authenticateRequest(
				new Request("https://docs.example.com/mcp", {
					headers: { "Cf-Access-Jwt-Assertion": token },
				}),
				{
					...env,
					AUTH_ADMIN_EMAILS: "admin@example.com",
				},
			),
		);

		expect(actor).toMatchObject({
			email: "admin@example.com",
			id: "admin@example.com",
			kind: "cloudflare-access",
		});
		expect(actor.roles).toEqual(["read", "editor", "admin"]);
		expect(actor.scopes).toEqual([
			"mcp:read",
			"mcp:write",
			"mcp:apply",
			"mcp:audit",
		]);
	});

	test("rejects missing JWTs with protected resource metadata challenge", async () => {
		const error = await captureHttpError(() =>
			authenticateRequest(new Request("https://docs.example.com/mcp"), {
				...baseEnv,
				CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
			}),
		);

		expect(error.status).toBe(401);
		expect(new Headers(error.headers).get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://docs.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
		);
	});

	test("rejects Access JWTs with an unexpected issuer", async () => {
		const { env, jwks, token } = await makeAccessToken("reader@example.com", {
			issuer: "https://other.cloudflareaccess.com",
		});

		const error = await withMockAccessCerts(env, jwks, () =>
			captureHttpError(() =>
				authenticateRequest(
					new Request("https://docs.example.com/mcp", {
						headers: { "Cf-Access-Jwt-Assertion": token },
					}),
					env,
				),
			),
		);

		expect(error.status).toBe(401);
		expect(new Headers(error.headers).get("WWW-Authenticate")).toContain(
			"resource_metadata=",
		);
	});

	test("rejects Access JWTs with an unexpected audience", async () => {
		const { env, jwks, token } = await makeAccessToken("reader@example.com", {
			audience: "wrong-audience",
		});

		const error = await withMockAccessCerts(env, jwks, () =>
			captureHttpError(() =>
				authenticateRequest(
					new Request("https://docs.example.com/mcp", {
						headers: { "Cf-Access-Jwt-Assertion": token },
					}),
					env,
				),
			),
		);

		expect(error.status).toBe(401);
		expect(new Headers(error.headers).get("WWW-Authenticate")).toContain(
			"resource_metadata=",
		);
	});

	test("rejects Access JWTs signed by a different key", async () => {
		const jwksKeyPair = await generateKeyPair("RS256");
		const signingKeyPair = await generateKeyPair("RS256");
		const { env, jwks, token } = await makeAccessToken("reader@example.com", {
			jwksPublicKey: jwksKeyPair.publicKey,
			signingPrivateKey: signingKeyPair.privateKey,
		});

		const error = await withMockAccessCerts(env, jwks, () =>
			captureHttpError(() =>
				authenticateRequest(
					new Request("https://docs.example.com/mcp", {
						headers: { "Cf-Access-Jwt-Assertion": token },
					}),
					env,
				),
			),
		);

		expect(error.status).toBe(401);
	});

	test("reports JWKS fetch failures as server errors", async () => {
		const { env, token } = await makeAccessToken("reader@example.com");

		const error = await withMockAccessCertsResponse(
			env,
			new Response("unavailable", { status: 503 }),
			() =>
				captureHttpError(() =>
					authenticateRequest(
						new Request("https://docs.example.com/mcp", {
							headers: { "Cf-Access-Jwt-Assertion": token },
						}),
						env,
					),
				),
		);

		expect(error.status).toBe(500);
		expect(new Headers(error.headers).has("WWW-Authenticate")).toBe(false);
	});

	test("fails closed for mutating permissions unless email is allowed", () => {
		const actor = {
			email: "reader@example.com",
			id: "reader@example.com",
			kind: "cloudflare-access",
			roles: ["read"],
			scopes: ["mcp:read"],
		} satisfies Awaited<ReturnType<typeof authenticateRequest>>;

		expect(() => requireActorPermission(actor, "read")).not.toThrow();
		expect(() => requireActorPermission(actor, "write")).toThrow(HttpError);
	});

	test("adds requested scope to HTTP insufficient-scope challenges", () => {
		const actor = {
			email: "reader@example.com",
			id: "reader@example.com",
			kind: "cloudflare-access",
			roles: ["read"],
			scopes: ["mcp:read"],
		} satisfies Awaited<ReturnType<typeof authenticateRequest>>;

		const error = captureSyncHttpError(() =>
			requireHttpPermission(
				new Request("https://docs.example.com/api/apply_update"),
				baseEnv,
				actor,
				"apply",
			),
		);

		expect(error.status).toBe(403);
		expect(new Headers(error.headers).get("WWW-Authenticate")).toContain(
			'scope="mcp:apply"',
		);
	});
});

describe("protected resource metadata", () => {
	test("describes the MCP resource and authorization server", () => {
		expect(
			buildProtectedResourceMetadata(
				new Request("https://docs.example.com/mcp"),
				baseEnv,
			),
		).toEqual({
			authorization_servers: ["https://docs.example.com/"],
			bearer_methods_supported: ["header"],
			resource: "https://docs.example.com/mcp",
			resource_name: "cf-ai-docs",
			scopes_supported: ["mcp:read", "mcp:write", "mcp:apply", "mcp:audit"],
		});
	});

	test("requires a trusted MCP_RESOURCE_URL for DNS rebinding fallback", () => {
		expect(getAllowedHosts(baseEnv)).toEqual(["docs.example.com"]);
		expect(getAllowedOrigins(baseEnv)).toEqual(["https://docs.example.com"]);
		expect(() =>
			getAllowedHosts({
				AI_SEARCH: undefined as unknown as Env["AI_SEARCH"],
			}),
		).toThrow("MCP_RESOURCE_URL is not configured.");
	});
});

async function makeAccessToken(
	email: string,
	options: {
		audience?: string;
		issuer?: string;
		jwksPublicKey?: CryptoKey;
		signingPrivateKey?: CryptoKey;
	} = {},
): Promise<{
	env: Env & { CF_ACCESS_TEAM_DOMAIN: string };
	jwks: JSONWebKeySet;
	token: string;
}> {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const kid = crypto.randomUUID();
	const publicJwk = await exportJWK(options.jwksPublicKey ?? publicKey);
	const teamDomain = `https://${kid}.cloudflareaccess.com`;
	const env = {
		...baseEnv,
		CF_ACCESS_TEAM_DOMAIN: teamDomain,
	} satisfies Env;
	const token = await new SignJWT({ email })
		.setProtectedHeader({ alg: "RS256", kid })
		.setIssuer(options.issuer ?? teamDomain)
		.setAudience(options.audience ?? baseEnv.CF_ACCESS_AUD)
		.setSubject(`user:${email}`)
		.setExpirationTime("5m")
		.sign(options.signingPrivateKey ?? privateKey);

	return {
		env,
		jwks: { keys: [{ ...publicJwk, alg: "RS256", kid, use: "sig" }] },
		token,
	};
}

async function withMockAccessCerts<T>(
	env: Env & { CF_ACCESS_TEAM_DOMAIN: string },
	jwks: JSONWebKeySet,
	handler: () => Promise<T>,
): Promise<T> {
	return withMockAccessCertsResponse(env, Response.json(jwks), handler);
}

async function withMockAccessCertsResponse<T>(
	env: Env & { CF_ACCESS_TEAM_DOMAIN: string },
	response: Response,
	handler: () => Promise<T>,
): Promise<T> {
	const expectedUrl = `${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === expectedUrl) {
			return Promise.resolve(response.clone());
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	try {
		return await handler();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function captureHttpError(
	handler: () => Promise<unknown>,
): Promise<HttpError> {
	try {
		await handler();
	} catch (error) {
		if (error instanceof HttpError) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected HttpError.");
}

function captureSyncHttpError(handler: () => void): HttpError {
	try {
		handler();
	} catch (error) {
		if (error instanceof HttpError) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected HttpError.");
}
