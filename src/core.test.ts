import { describe, expect, test } from "bun:test";
import {
	type AuditLogInput,
	type Env,
	buildAuditLogQuery,
	getProposalMaxBytes,
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
