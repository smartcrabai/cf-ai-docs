import { describe, expect, test } from "bun:test";
import { buildMcpHandlerOptions } from "./index";
import type { Actor, Env } from "./core";

const actor = {
	email: "admin@example.com",
	id: "admin@example.com",
	kind: "cloudflare-access",
	roles: ["read", "editor", "admin"],
	scopes: ["mcp:read", "mcp:write", "mcp:apply", "mcp:audit"],
} satisfies Actor;

describe("buildMcpHandlerOptions", () => {
	test("enables Streamable HTTP SSE and DNS rebinding protection", () => {
		const options = buildMcpHandlerOptions(
			new Request("https://docs.example.com/mcp", {
				headers: { Origin: "https://client.example.com" },
			}),
			{
				AI_SEARCH: undefined as unknown as Env["AI_SEARCH"],
				MCP_ALLOWED_HOSTS: "docs.example.com",
				MCP_ALLOWED_ORIGINS: "https://client.example.com",
				MCP_RESOURCE_URL: "https://docs.example.com/mcp",
			},
			actor,
		) as Record<string, unknown>;

		expect(options.route).toBe("/mcp");
		expect(options.allowedHosts).toEqual(["docs.example.com"]);
		expect(options.allowedOrigins).toEqual(["https://client.example.com"]);
		expect(options.enableDnsRebindingProtection).toBe(true);
		expect(options.enableJsonResponse).toBeUndefined();
		expect(options.authContext).toEqual({ props: { actor } });
		expect(options.corsOptions).toEqual({
			exposeHeaders: "Mcp-Session-Id, mcp-session-id",
			headers:
				"Authorization, Content-Type, Accept, Mcp-Protocol-Version, mcp-protocol-version, Mcp-Session-Id, mcp-session-id, Last-Event-ID, last-event-id",
			methods: "GET, POST, DELETE, OPTIONS",
			origin: "https://client.example.com",
		});
	});
});
