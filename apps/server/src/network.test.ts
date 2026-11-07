import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENCODE_API_KEY;
process.env.OPENCODE_API_KEY = "test-key";
const { runWritingWorkflow } = await import("./network");
if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
else process.env.OPENCODE_API_KEY = originalKey;
const expectedModel = process.env.OPENCODE_MODEL?.trim() || "minimax-m3";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("all LLM steps and retries use the configured model despite planner overrides", async () => {
	const models: string[] = [];
	const urls: string[] = [];
	const replies = [
		{
			tasks: ["write", "edit", "review", "improve"].map((type, i) => ({
				id: `t${i}`,
				type,
				title: type,
				status: "pending",
				model: "unwanted-model",
			})),
			model_strategy: { writing: { light: { model: "other-model" } } },
		},
		{ draft: "draft" },
		{ draft: "edited draft" },
		{ issues: [], suggested_improvements: [] },
		{ final_document: "final draft" },
	];
	let calls = 0;
	globalThis.fetch = (async (url: unknown, init: RequestInit) => {
		urls.push(String(url));
		models.push(JSON.parse(String(init.body)).model);
		if (calls++ === 1)
			return new Response("temporary failure", { status: 503 });
		const text = JSON.stringify(replies.shift());
		return Response.json({
			content: [{ type: "text", text }],
			choices: [{ message: { content: text } }],
		});
	}) as typeof fetch;
	const result = await runWritingWorkflow("Improve this", "existing document");
	expect(result.success).toBe(true);
	expect(result.finalDocument).toBe("final draft");
	expect(models).toEqual(Array(6).fill(expectedModel));
	const endpoint =
		expectedModel.startsWith("minimax-") || expectedModel.startsWith("qwen3.")
			? "/messages"
			: "/chat/completions";
	expect(urls.every((url) => url.endsWith(endpoint))).toBe(true);
	expect(
		result.state.plan?.tasks?.every((task) => task.model === expectedModel),
	).toBe(true);
});

test("planning failures stop after one retry on the same model", async () => {
	const models: string[] = [];
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		models.push(JSON.parse(String(init.body)).model);
		return new Response("unavailable", { status: 503 });
	}) as typeof fetch;
	await expect(runWritingWorkflow("Write a draft")).rejects.toThrow(
		"OpenCode Go request failed (503)",
	);
	expect(models).toEqual([expectedModel, expectedModel]);
});
