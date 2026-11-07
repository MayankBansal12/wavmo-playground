export type TaskType = "research" | "write" | "edit" | "review" | "improve";
export type TaskDifficulty = "light" | "high_end";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WritingTask {
	id: string;
	type: TaskType;
	title: string;
	description?: string;
	depends_on?: string[];
	status: TaskStatus;
	difficulty?: TaskDifficulty;
	model?: string;
	outputs?: Record<string, unknown>;
}

export interface WritingPlan {
	intent: string;
	requirements: string;
	outline: string;
	tone: string;
	constraints: string;
	optional_search_queries?: string[];
	mode?: "write" | "edit" | "review" | "research";
	tasks?: WritingTask[];
	needs_review?: boolean;
	needs_improvement?: boolean;
	edit_scope?: "none" | "small" | "medium" | "large";
	stop_conditions?: {
		max_calls?: number;
	};
}

export interface WritingDraft {
	draft: string;
}

export interface WritingReview {
	issues: string[];
	missing_elements: string[];
	tone_mismatches: string[];
	structural_problems: string[];
	suggested_improvements: string[];
}

export interface FinalDocument {
	final_document: string;
}

export interface WritingAgentState {
	userPrompt: string;
	currentDocument?: string;
	plan?: WritingPlan;
	draft?: string;
	review?: WritingReview;
	finalDocument?: string;
}

export interface AgentTiming {
	name: string;
	duration: number;
}
