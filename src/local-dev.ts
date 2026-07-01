import type { Env } from "./core";
import { handleRequest } from "./index";
import { createLocalMockEnv, type LocalSeedDocument } from "./local-mocks";

const port = Number(Bun.env.PORT ?? "8787");
const hostname = Bun.env.HOST ?? "127.0.0.1";
const env = createLocalMockEnv({
	defaultInstance: Bun.env.DEFAULT_AI_SEARCH_INSTANCE ?? "docs",
	documents: await loadSeedDocuments(Bun.env.LOCAL_DOCS_SEED),
});

Bun.serve({
	fetch: (request) =>
		handleRequest(request, env, createLocalExecutionContext()),
	hostname,
	port,
});

console.log(`cf-ai-docs mock server: http://${hostname}:${port}`);
console.log(
	"Seed docs: runbooks/api-keys.md, architecture/rag-updates.md, r2/policies/access.md",
);

async function loadSeedDocuments(
	path: string | undefined,
): Promise<LocalSeedDocument[] | undefined> {
	if (!path) {
		return undefined;
	}

	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`LOCAL_DOCS_SEED does not exist: ${path}`);
	}
	return JSON.parse(await file.text()) as LocalSeedDocument[];
}

function createLocalExecutionContext(): ExecutionContext {
	return {
		passThroughOnException() {},
		props: {},
		tracing: {},
		waitUntil(promise: Promise<unknown>) {
			promise.catch((error: unknown) => {
				console.error("waitUntil failed", error);
			});
		},
	} as unknown as ExecutionContext;
}

export function createLocalRequestEnv(): Env {
	return env;
}
