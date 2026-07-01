import { describe, expect, test } from "bun:test";
import {
	type AuditLogInput,
	type Env,
	HttpError,
	buildAuditLogQuery,
	getProposalMaxBytes,
	identifyActor,
	sha256Hex,
} from "./core";

const baseEnv = {
	AI_SEARCH: undefined as unknown as Env["AI_SEARCH"],
} satisfies Env;

describe("sha256Hex", () => {
	test("hashes text as lowercase hex", async () => {
		expect(await sha256Hex("hello")).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});
});

describe("identifyActor", () => {
	test("uses Cloudflare Access email only when explicitly trusted", () => {
		const request = new Request("https://example.com/mcp", {
			headers: {
				"Cf-Access-Authenticated-User-Email": "agent@example.com",
			},
		});

		expect(identifyActor(request, baseEnv)).toEqual({
			id: "anonymous",
			kind: "anonymous",
		});
		expect(
			identifyActor(request, { ...baseEnv, TRUST_CF_ACCESS_HEADERS: "true" }),
		).toEqual({
			email: "agent@example.com",
			id: "agent@example.com",
			kind: "cloudflare-access",
		});
	});

	test("does not let spoofed Cloudflare Access headers bypass required auth", () => {
		const request = new Request("https://example.com/mcp", {
			headers: {
				"Cf-Access-Authenticated-User-Email": "agent@example.com",
			},
		});

		expect(() =>
			identifyActor(request, { ...baseEnv, REQUIRE_AUTH: "true" }),
		).toThrow(HttpError);
	});

	test("requires a matching bearer token when configured", () => {
		const request = new Request("https://example.com/mcp", {
			headers: {
				"Cf-Access-Authenticated-User-Email": "agent@example.com",
				Authorization: "Bearer secret",
			},
		});

		expect(
			identifyActor(request, { ...baseEnv, AGENT_API_TOKEN: "secret" }),
		).toEqual({
			id: "agent-token",
			kind: "bearer",
		});
		expect(() =>
			identifyActor(request, { ...baseEnv, AGENT_API_TOKEN: "different" }),
		).toThrow(HttpError);
	});

	test("allows anonymous only when auth is not required", () => {
		const request = new Request("https://example.com/mcp");

		expect(identifyActor(request, baseEnv)).toEqual({
			id: "anonymous",
			kind: "anonymous",
		});
		expect(() =>
			identifyActor(request, { ...baseEnv, REQUIRE_AUTH: "true" }),
		).toThrow(HttpError);
	});
});

describe("configuration helpers", () => {
	test("uses a safe default proposal size", () => {
		expect(getProposalMaxBytes(baseEnv)).toBe(2_000_000);
		expect(
			getProposalMaxBytes({ ...baseEnv, PROPOSAL_MAX_BYTES: "1234" }),
		).toBe(1234);
		expect(getProposalMaxBytes({ ...baseEnv, PROPOSAL_MAX_BYTES: "-1" })).toBe(
			2_000_000,
		);
	});
});

describe("buildAuditLogQuery", () => {
	test("builds a parameterized filtered query", () => {
		const input = {
			action: "apply_update",
			actor: "agent@example.com",
			limit: 25,
			offset: 50,
			proposal_id: "proposal-1",
		} satisfies AuditLogInput;

		expect(buildAuditLogQuery(input)).toEqual({
			bindings: ["proposal-1", "apply_update", "agent@example.com", 25, 50],
			sql: "SELECT * FROM audit_events WHERE proposal_id = ? AND action = ? AND actor = ? ORDER BY id DESC LIMIT ? OFFSET ?",
		});
	});
});
