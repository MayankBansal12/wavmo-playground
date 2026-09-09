import { randomUUID } from "node:crypto";
import { createEditPrompt } from "./helpers/prompts/edit";
import { createImprovementPrompt } from "./helpers/prompts/improvement";
import { createPlanningPrompt } from "./helpers/prompts/planning";
import { createReviewPrompt } from "./helpers/prompts/review";
import { createWritingPrompt } from "./helpers/prompts/writing";
import { parseJSON } from "./helpers/utils";
import type {
	FinalDocument,
	ModelRoutingChoice,
	ModelRoutingPlan,
	TaskStatus,
	TaskType,
	WritingAgentState,
	WritingDraft,
	WritingPlan,
	WritingReview,
	WritingTask,
} from "./types";

type StreamEvent =
	| { event: "plan"; data: { plan: WritingPlan } }
	| {
			event: "task_start";
			data: { task: WritingTask; status: TaskStatus };
	  }
	| {
			event: "task_update";
			data: { task: WritingTask; status: TaskStatus };
	  }
	| {
			event: "task_done";
			data: { task: WritingTask; status: TaskStatus };
	  }
	| {
			event: "final";
			data: { finalDocument?: string; state: WritingAgentState };
	  };

type StreamHandler = (event: StreamEvent) => void;

type WorkflowLogger = Pick<Console, "info" | "warn" | "error">;

interface WorkflowContext {
	streamId?: string;
	sessionId?: string;
	log?: WorkflowLogger;
}

const openCodeEndpoint =
	process.env.OPENCODE_API_BASE_URL || "https://opencode.ai/zen/go/v1";
const openCodeApiKey = process.env.OPENCODE_API_KEY || "";
const openCodeUserAgent = process.env.OPENCODE_USER_AGENT || "wavmo-server/1.0";

const usesAnthropicMessagesApi = (model: string) =>
	model.startsWith("minimax-") || model.startsWith("qwen3.");

const extractTextContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				(part as { type?: string }).type === "text" &&
				"text" in part
			) {
				return String((part as { text: unknown }).text);
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
};

const snippet = (value: string, length = 500) =>
	value.length > length ? `${value.slice(0, length)}…` : value;

const invokeAgent = async (
	model: string,
	prompt: string,
	sessionId: string,
): Promise<string> => {
	if (!openCodeApiKey) {
		throw new Error("OPENCODE_API_KEY is not configured");
	}

	const usesMessagesApi = usesAnthropicMessagesApi(model);
	const response = await fetch(
		`${openCodeEndpoint.replace(/\/$/, "")}/${usesMessagesApi ? "messages" : "chat/completions"}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${openCodeApiKey}`,
				"User-Agent": openCodeUserAgent,
				"x-opencode-session": sessionId,
				...(usesMessagesApi
					? {
							"x-api-key": openCodeApiKey,
							"anthropic-version": "2023-06-01",
						}
					: {}),
			},
			body: JSON.stringify({
				model,
				temperature: 0,
				...(usesMessagesApi ? { max_tokens: 8192 } : {}),
				messages: [{ role: "user", content: prompt }],
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(
			`OpenCode Go request failed (${response.status}): ${errorBody}`,
		);
	}

	const json = (await response.json()) as {
		choices?: Array<{ message?: { content?: unknown } }>;
		content?: unknown;
	};
	const content = extractTextContent(
		usesMessagesApi ? json.content : json?.choices?.[0]?.message?.content,
	);

	if (!content) {
		throw new Error(`Model ${model} returned empty content`);
	}

	return content;
};

const resolveModel = (fallback: string, envKey: string) =>
	process.env[envKey] || fallback;

const modelRoutes = {
	planning: {
		primary: resolveModel("minimax-m3", "OPENCODE_MODEL_PLANNING"),
		fallback: resolveModel(
			"deepseek-v4-flash",
			"OPENCODE_MODEL_PLANNING_FALLBACK",
		),
	},
	writing: {
		high_end: resolveModel("minimax-m3", "OPENCODE_MODEL_WRITER_HIGH_END"),
		light: resolveModel("deepseek-v4-flash", "OPENCODE_MODEL_WRITER_LIGHT"),
	},
	review: {
		high_end: resolveModel("minimax-m3", "OPENCODE_MODEL_REVIEW_HIGH_END"),
		light: resolveModel("deepseek-v4-flash", "OPENCODE_MODEL_REVIEW_LIGHT"),
	},
	improvement: {
		high_end: resolveModel("minimax-m3", "OPENCODE_MODEL_IMPROVEMENT_HIGH_END"),
		light: resolveModel(
			"deepseek-v4-flash",
			"OPENCODE_MODEL_IMPROVEMENT_LIGHT",
		),
	},
	research: {
		primary: resolveModel("minimax-m3", "OPENCODE_MODEL_RESEARCH"),
		fallback: resolveModel(
			"deepseek-v4-flash",
			"OPENCODE_MODEL_RESEARCH_FALLBACK",
		),
	},
};

const defaultModelRouting: ModelRoutingPlan = {
	planning: modelRoutes.planning,
	writing: {
		high_end: { model: modelRoutes.writing.high_end, difficulty: "high_end" },
		light: { model: modelRoutes.writing.light, difficulty: "light" },
	},
	review: {
		high_end: { model: modelRoutes.review.high_end, difficulty: "high_end" },
		light: { model: modelRoutes.review.light, difficulty: "light" },
	},
	research: modelRoutes.research,
	improvement: {
		high_end: {
			model: modelRoutes.improvement.high_end,
			difficulty: "high_end",
		},
		light: { model: modelRoutes.improvement.light, difficulty: "light" },
	},
};

const resolveModelRouting = (routing?: ModelRoutingPlan): ModelRoutingPlan => {
	const normalizeChoice = (
		fallback: ModelRoutingChoice,
		choice?: Partial<ModelRoutingChoice>,
	): ModelRoutingChoice => ({
		model: choice?.model || fallback.model,
		difficulty: choice?.difficulty || fallback.difficulty,
	});

	return {
		planning: {
			primary:
				routing?.planning?.primary || defaultModelRouting.planning.primary,
			fallback:
				routing?.planning?.fallback || defaultModelRouting.planning.fallback,
		},
		writing: {
			high_end: normalizeChoice(
				defaultModelRouting.writing.high_end,
				routing?.writing?.high_end,
			),
			light: normalizeChoice(
				defaultModelRouting.writing.light,
				routing?.writing?.light,
			),
		},
		review: {
			high_end: normalizeChoice(
				defaultModelRouting.review.high_end,
				routing?.review?.high_end,
			),
			light: normalizeChoice(
				defaultModelRouting.review.light,
				routing?.review?.light,
			),
		},
		research: {
			primary:
				routing?.research?.primary || defaultModelRouting.research.primary,
			fallback:
				routing?.research?.fallback || defaultModelRouting.research.fallback,
		},
		improvement: {
			high_end: normalizeChoice(
				defaultModelRouting.improvement!.high_end,
				routing?.improvement?.high_end,
			),
			light: normalizeChoice(
				defaultModelRouting.improvement!.light,
				routing?.improvement?.light,
			),
		},
	};
};

const resolveTaskRouting = (
	task: WritingTask,
	plan: WritingPlan,
	routing: ModelRoutingPlan,
): ModelRoutingChoice => {
	const requestedDifficulty = task.difficulty;
	const inferredDifficulty =
		requestedDifficulty ||
		(task.type === "review"
			? plan.needs_review === false
				? "light"
				: "high_end"
			: task.type === "improve"
				? plan.needs_improvement === false
					? "light"
					: "high_end"
				: plan.edit_scope === "large"
					? "high_end"
					: "light");

	if (task.type === "review") {
		return routing.review[inferredDifficulty];
	}
	if (
		task.type === "improve" ||
		task.type === "edit" ||
		task.type === "write"
	) {
		return routing.writing[inferredDifficulty];
	}
	return {
		model: routing.research.primary,
		difficulty: "light",
	};
};

const getFallbackModel = (
	task: WritingTask,
	routing: ModelRoutingPlan,
): string => {
	if (task.type === "review") {
		return task.difficulty === "high_end"
			? routing.review.light.model
			: routing.review.high_end.model;
	}

	if (task.type === "research") {
		return routing.research.fallback;
	}

	return task.difficulty === "high_end"
		? routing.writing.light.model
		: routing.writing.high_end.model;
};

const withFallback = async (
	primary: string,
	fallback: string,
	prompt: string,
	sessionId: string,
): Promise<string> => {
	try {
		return await invokeAgent(primary, prompt, sessionId);
	} catch {
		return await invokeAgent(fallback, prompt, sessionId);
	}
};

const parseJsonWithLogging = <T>(
	label: string,
	text: string,
	logError: (message: string, extra?: Record<string, unknown>) => void,
): T | null => {
	const parsed = parseJSON<T>(text);
	if (parsed) return parsed;

	logError(`${label} returned invalid json`, {
		responseLength: text.length,
		responsePreview: snippet(text),
	});
	return null;
};

const getErrorDetails = (error: unknown) => {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack,
		};
	}

	return { error };
};

const runResearch = async (
	queries: string[],
	_primaryModel: string,
	_fallbackModel: string,
): Promise<string> => {
	const apiKey = process.env.FIRECRAWL_API_KEY || "";
	if (!apiKey || queries.length === 0) return "";

	const summaries: string[] = [];
	for (const query of queries) {
		const response = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query, limit: 3 }),
		});

		if (!response.ok) continue;
		const json = (await response.json()) as {
			data?: Array<{ title?: string; url?: string; snippet?: string }>;
		};

		const items = json?.data || [];
		const summary = items
			.map((item) =>
				[item.title, item.url, item.snippet].filter(Boolean).join(" - "),
			)
			.join("\n");
		if (summary) summaries.push(`Query: ${query}\n${summary}`);
	}

	return summaries.join("\n\n");
};

const pickTasks = (plan?: WritingPlan): WritingTask[] => {
	if (plan?.tasks?.length) return plan.tasks;

	const defaultTasks: WritingTask[] = [
		{
			id: "t-write",
			type: "write",
			title: "Write the draft",
			status: "pending",
		},
		{
			id: "t-review",
			type: "review",
			title: "Review the draft",
			depends_on: ["t-write"],
			status: "pending",
		},
		{
			id: "t-improve",
			type: "improve",
			title: "Apply review improvements",
			depends_on: ["t-review"],
			status: "pending",
		},
	];

	if (plan?.mode === "review") {
		return [
			{
				id: "t-review",
				type: "review",
				title: "Review the document",
				status: "pending",
			},
		];
	}

	if (plan?.mode === "edit") {
		return [
			{
				id: "t-edit",
				type: "edit",
				title: "Edit the document",
				status: "pending",
			},
			{
				id: "t-review",
				type: "review",
				title: "Review the edit",
				depends_on: ["t-edit"],
				status: "pending",
			},
			{
				id: "t-improve",
				type: "improve",
				title: "Apply review improvements",
				depends_on: ["t-review"],
				status: "pending",
			},
		];
	}

	return defaultTasks;
};

const sanitizeTasks = (tasks: WritingTask[]): WritingTask[] => {
	const filtered = tasks.filter((task) =>
		(["research", "write", "edit", "review", "improve"] as TaskType[]).includes(
			task.type,
		),
	);

	const normalized = filtered.map((task, index) => ({
		...task,
		id: task.id || `task-${index + 1}`,
		status: task.status || "pending",
	}));

	const knownIds = new Set(normalized.map((task) => task.id));
	return normalized.map((task, index) => {
		const explicitDeps = (task.depends_on || []).filter((id) =>
			knownIds.has(id),
		);
		if (index === 0) {
			return { ...task, depends_on: [] };
		}

		if (explicitDeps.length > 0) {
			return { ...task, depends_on: explicitDeps };
		}

		const previousTask = normalized[index - 1];
		return {
			...task,
			depends_on: previousTask ? [previousTask.id] : [],
		};
	});
};

const isTaskReady = (task: WritingTask, doneIds: Set<string>) =>
	(task.depends_on || []).every((id) => doneIds.has(id));

export interface OrchestratorResult {
	success: boolean;
	finalDocument?: string;
	state: WritingAgentState;
}

export async function runWritingWorkflow(
	userPrompt: string,
	currentDocument?: string,
	contextOrOnEvent?: WorkflowContext | StreamHandler,
	onEvent?: StreamHandler,
): Promise<OrchestratorResult> {
	const context =
		typeof contextOrOnEvent === "function" ? undefined : contextOrOnEvent;
	const streamHandler =
		typeof contextOrOnEvent === "function" ? contextOrOnEvent : onEvent;
	const log = context?.log;
	const streamId = context?.streamId;
	const logInfo = (message: string, extra: Record<string, unknown> = {}) =>
		log?.info?.({ streamId, ...extra }, message);
	const logWarn = (message: string, extra: Record<string, unknown> = {}) =>
		log?.warn?.({ streamId, ...extra }, message);
	const logError = (message: string, extra: Record<string, unknown> = {}) =>
		log?.error?.({ streamId, ...extra }, message);

	const workflowStartedAt = Date.now();
	const sessionId = context?.sessionId || randomUUID();
	logInfo("workflow planning started", { sessionId });

	const planningPrompt = createPlanningPrompt(currentDocument, userPrompt);
	let planningResponse: string;
	try {
		logInfo("planning agent call started", {
			model: modelRoutes.planning.primary,
			fallbackModel: modelRoutes.planning.fallback,
		});
		planningResponse = await withFallback(
			modelRoutes.planning.primary,
			modelRoutes.planning.fallback,
			planningPrompt,
			sessionId,
		);
		logInfo("planning agent call completed", {
			responseLength: planningResponse.length,
		});
	} catch (error) {
		logError("planning agent call failed", getErrorDetails(error));
		throw error;
	}
	const plan = parseJSON<WritingPlan>(planningResponse);

	if (!plan) {
		logError("planning agent returned invalid json");
		throw new Error("Planning agent did not return a valid JSON plan");
	}
	logInfo("plan parsed", {
		mode: plan.mode,
		taskCount: plan.tasks?.length || 0,
		maxCalls: plan.stop_conditions?.max_calls ?? 8,
	});

	const routing = resolveModelRouting(plan.model_strategy);
	const tasks = sanitizeTasks(pickTasks(plan)).map((task) => {
		const routed = resolveTaskRouting(task, plan, routing);
		return {
			...task,
			difficulty: task.difficulty || routed.difficulty,
			model: task.model || routed.model,
		};
	});
	const maxCalls = plan.stop_conditions?.max_calls ?? 8;
	logInfo("tasks sanitized", {
		taskCount: tasks.length,
		taskTypes: tasks.map((task) => task.type),
		models: tasks.map((task) => ({
			id: task.id,
			type: task.type,
			model: task.model,
			difficulty: task.difficulty,
		})),
	});
	const state: WritingAgentState = {
		userPrompt,
		currentDocument,
		plan: { ...plan, tasks, model_strategy: routing },
	};

	streamHandler?.({ event: "plan", data: { plan: state.plan as WritingPlan } });
	logInfo("plan streamed to client");
	for (const task of tasks) {
		streamHandler?.({
			event: "task_update",
			data: { task, status: task.status },
		});
		logInfo("task state streamed to client", {
			taskId: task.id,
			taskType: task.type,
			status: task.status,
		});
	}

	let callCount = 0;
	const doneIds = new Set<string>();
	let workingDraft = "";
	let reviewResult: WritingReview | undefined;
	let researchContext = "";

	while (callCount < maxCalls) {
		const readyTask = tasks.find(
			(task) => task.status === "pending" && isTaskReady(task, doneIds),
		);
		if (!readyTask) break;

		readyTask.status = "running";
		logInfo("task execution started", {
			taskId: readyTask.id,
			taskType: readyTask.type,
			callCount,
		});
		streamHandler?.({
			event: "task_start",
			data: { task: readyTask, status: "running" },
		});
		logInfo("task start streamed to client", {
			taskId: readyTask.id,
			taskType: readyTask.type,
		});

		try {
			callCount += 1;
			switch (readyTask.type) {
				case "research": {
					const queries = plan.optional_search_queries || [];
					logInfo("research agent started", {
						taskId: readyTask.id,
						queryCount: queries.length,
						model: routing.research.primary,
						fallbackModel: routing.research.fallback,
					});
					const researchSummary = await runResearch(
						queries,
						routing.research.primary,
						routing.research.fallback,
					);
					researchContext = researchSummary;
					readyTask.outputs = { researchSummary };
					readyTask.status = "done";
					streamHandler?.({
						event: "task_update",
						data: { task: readyTask, status: "done" },
					});
					logInfo("research agent completed", {
						taskId: readyTask.id,
						hasResearchSummary: Boolean(researchSummary),
					});
					break;
				}
				case "write": {
					const writingPrompt = createWritingPrompt(
						plan,
						currentDocument,
						researchContext,
						readyTask.model,
						readyTask.difficulty,
					);
					logInfo("writing agent call started", {
						taskId: readyTask.id,
						model: readyTask.model,
						difficulty: readyTask.difficulty,
					});
					const writingResponse = await withFallback(
						readyTask.model || routing.writing.light.model,
						getFallbackModel(readyTask, routing),
						writingPrompt,
						sessionId,
					);
					logInfo("writing agent call completed", {
						taskId: readyTask.id,
						responseLength: writingResponse.length,
					});
					const result = parseJsonWithLogging<WritingDraft>(
						"writing agent",
						writingResponse,
						logError,
					);
					if (!result?.draft) {
						logError("writing agent draft missing after parse", {
							taskId: readyTask.id,
							responseLength: writingResponse.length,
							responsePreview: snippet(writingResponse),
						});
						throw new Error("Writing agent did not return a draft");
					}
					workingDraft = result.draft;
					state.draft = workingDraft;
					readyTask.outputs = { draft: workingDraft };
					readyTask.status = "done";
					streamHandler?.({
						event: "task_update",
						data: { task: readyTask, status: "done" },
					});
					logInfo("writing agent result streamed to client", {
						taskId: readyTask.id,
					});
					break;
				}
				case "edit": {
					const sourceDocument = currentDocument || workingDraft;
					if (!sourceDocument) {
						throw new Error("Editing step requires a current document");
					}
					const editingPrompt = createEditPrompt(
						sourceDocument,
						userPrompt,
						researchContext,
						readyTask.model,
						readyTask.difficulty,
					);
					logInfo("editing agent call started", {
						taskId: readyTask.id,
						model: readyTask.model,
						difficulty: readyTask.difficulty,
					});
					const editingResponse = await withFallback(
						readyTask.model || routing.writing.light.model,
						getFallbackModel(readyTask, routing),
						editingPrompt,
						sessionId,
					);
					logInfo("editing agent call completed", {
						taskId: readyTask.id,
						responseLength: editingResponse.length,
					});
					const result = parseJsonWithLogging<WritingDraft>(
						"editing agent",
						editingResponse,
						logError,
					);
					if (!result?.draft) {
						logError("editing agent draft missing after parse", {
							taskId: readyTask.id,
							responseLength: editingResponse.length,
							responsePreview: snippet(editingResponse),
						});
						throw new Error("Editing agent did not return an updated draft");
					}
					workingDraft = result.draft;
					state.draft = workingDraft;
					readyTask.outputs = { draft: workingDraft };
					readyTask.status = "done";
					streamHandler?.({
						event: "task_update",
						data: { task: readyTask, status: "done" },
					});
					logInfo("editing agent result streamed to client", {
						taskId: readyTask.id,
					});
					break;
				}
				case "review": {
					const draftToReview = workingDraft || currentDocument;
					if (!draftToReview) {
						throw new Error("Review step requires a draft or current document");
					}
					const reviewPrompt = createReviewPrompt(
						plan,
						draftToReview,
						currentDocument,
						readyTask.model,
						readyTask.difficulty,
					);
					logInfo("review agent call started", {
						taskId: readyTask.id,
						model: readyTask.model,
						difficulty: readyTask.difficulty,
					});
					const reviewResponse = await withFallback(
						readyTask.model || routing.review.light.model,
						getFallbackModel(readyTask, routing),
						reviewPrompt,
						sessionId,
					);
					logInfo("review agent call completed", {
						taskId: readyTask.id,
						responseLength: reviewResponse.length,
					});
					const review = parseJsonWithLogging<WritingReview>(
						"review agent",
						reviewResponse,
						logError,
					);
					if (!review) {
						logError("review agent feedback missing after parse", {
							taskId: readyTask.id,
							responseLength: reviewResponse.length,
							responsePreview: snippet(reviewResponse),
						});
						throw new Error(
							"Review agent did not return valid review feedback",
						);
					}
					reviewResult = review;
					state.review = review;
					readyTask.outputs = { review };
					readyTask.status = "done";
					streamHandler?.({
						event: "task_update",
						data: { task: readyTask, status: "done" },
					});
					logInfo("review agent result streamed to client", {
						taskId: readyTask.id,
					});
					break;
				}
				case "improve": {
					if (!workingDraft || !reviewResult) {
						throw new Error(
							"Improvement step requires both draft and review data",
						);
					}
					const improvementPrompt = createImprovementPrompt(
						workingDraft,
						reviewResult,
						currentDocument,
						readyTask.model,
						readyTask.difficulty,
					);
					logInfo("improvement agent call started", {
						taskId: readyTask.id,
						model: readyTask.model,
						difficulty: readyTask.difficulty,
					});
					const improvementResponse = await withFallback(
						readyTask.model || routing.improvement.light.model,
						getFallbackModel(readyTask, routing),
						improvementPrompt,
						sessionId,
					);
					logInfo("improvement agent call completed", {
						taskId: readyTask.id,
						responseLength: improvementResponse.length,
					});
					const finalResult = parseJsonWithLogging<FinalDocument>(
						"improvement agent",
						improvementResponse,
						logError,
					);
					if (!finalResult?.final_document) {
						logError("improvement agent final document missing after parse", {
							taskId: readyTask.id,
							responseLength: improvementResponse.length,
							responsePreview: snippet(improvementResponse),
						});
						throw new Error(
							"Improvement agent did not return the final document",
						);
					}
					state.finalDocument = finalResult.final_document;
					readyTask.outputs = { finalDocument: finalResult.final_document };
					readyTask.status = "done";
					streamHandler?.({
						event: "task_update",
						data: { task: readyTask, status: "done" },
					});
					logInfo("improvement agent result streamed to client", {
						taskId: readyTask.id,
					});
					break;
				}
				default:
					readyTask.status = "skipped";
			}
			readyTask.status = "done";
			doneIds.add(readyTask.id);
			streamHandler?.({
				event: "task_done",
				data: { task: readyTask, status: "done" },
			});
			logInfo("task completed", {
				taskId: readyTask.id,
				taskType: readyTask.type,
			});
		} catch (error) {
			readyTask.status = "failed";
			logWarn("task failed", {
				taskId: readyTask.id,
				taskType: readyTask.type,
				...getErrorDetails(error),
			});
			streamHandler?.({
				event: "task_update",
				data: { task: readyTask, status: "failed" },
			});
			if (callCount >= maxCalls) break;
		}
	}

	if (workingDraft && !state.draft) {
		state.draft = workingDraft;
	}

	const normalizedState: WritingAgentState = {
		userPrompt,
		currentDocument,
		plan: state.plan,
		draft: state.draft,
		review: state.review,
		finalDocument: state.finalDocument,
	};

	const result: OrchestratorResult = {
		success: !!(
			normalizedState.finalDocument ||
			normalizedState.draft ||
			normalizedState.review
		),
		finalDocument: normalizedState.finalDocument,
		state: normalizedState,
	};

	streamHandler?.({
		event: "final",
		data: { finalDocument: result.finalDocument, state: result.state },
	});
	logInfo("workflow completed", {
		durationMs: Date.now() - workflowStartedAt,
		success: result.success,
		hasFinalDocument: Boolean(result.finalDocument),
	});

	return result;
}
