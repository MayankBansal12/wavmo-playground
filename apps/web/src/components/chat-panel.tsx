"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { diffLines } from "diff";
import {
	ArrowUp,
	CheckLine,
	ChevronDown,
	ChevronUp,
	Copy,
	RotateCcw,
	Square,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { promptSuggestions } from "@/lib/constants/suggestions";
import {
	loadChat,
	loadSessionId,
	type PersistedChatMessage,
	resetSessionId,
	saveChat,
} from "@/lib/db";
import { cn } from "@/lib/utils";
import { ChainOfThoughtReasoning } from "./chain-of-thought-reasoning";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
} from "./ui/message";
import {
	PromptInput,
	PromptInputAction,
	PromptInputActions,
	type PromptInputRef,
	PromptInputTextarea,
} from "./ui/prompt-input";
import { PromptSuggestion } from "./ui/prompt-suggestion";
import { SystemMessage } from "./ui/system-message";

interface WritingAgentState {
	userPrompt: string;
	currentDocument?: string;
	plan?: {
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
	};
	draft?: string;
	review?: {
		issues: string[];
		missing_elements: string[];
		tone_mismatches: string[];
		structural_problems: string[];
		suggested_improvements: string[];
	};
	finalDocument?: string;
}

type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";
type TaskType = "research" | "write" | "edit" | "review" | "improve";

type WritingTask = {
	id: string;
	type: TaskType;
	title: string;
	description?: string;
	depends_on?: string[];
	status: TaskStatus;
	outputs?: Record<string, unknown>;
};

interface ChatMessage {
	id: string;
	content: string;
	role: "user" | "assistant";
	stateData?: WritingAgentState;
	canReviewDiff?: boolean;
}

type DiffLineType = "equal" | "add" | "remove" | "empty";

type DiffLine = {
	id: string;
	original: string;
	suggested: string;
	originalType: DiffLineType;
	suggestedType: DiffLineType;
};

type DiffReview = {
	original: string;
	suggested: string;
	diff: DiffLine[];
};

type StreamEvent =
	| { event: "plan"; data: { plan: WritingAgentState["plan"] } }
	| {
			event: "task_start" | "task_update" | "task_done";
			data: { task: WritingTask; status: TaskStatus };
	  }
	| {
			event: "final";
			data: { finalDocument?: string; state: WritingAgentState };
	  }
	| { event: "agent_error"; data: { message: string } };

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface QuotaState {
	limit: number;
	remaining: number;
	resetAt: number;
}

export function ChatPanel({
	changeDocument,
	currentDocument,
}: {
	changeDocument: (content: string) => void;
	currentDocument: string;
}) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [inputValue, setInputValue] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [diffReview, setDiffReview] = useState<DiffReview | null>(null);
	const [streamState, setStreamState] = useState<WritingAgentState | null>(
		null,
	);
	const [streamTasks, setStreamTasks] = useState<WritingTask[]>([]);
	const [quota, setQuota] = useState<QuotaState | null>(null);
	const [resetDialogOpen, setResetDialogOpen] = useState(false);
	const promptInputRef = useRef<PromptInputRef>(null);
	const hydratedRef = useRef(false);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const [showScrollTop, setShowScrollTop] = useState(false);
	const [showScrollBottom, setShowScrollBottom] = useState(false);
	const [isScrolling, setIsScrolling] = useState(false);
	const isFirstAutoScroll = useRef(true);
	const hideButtonsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	const persistedMessages = useLiveQuery(() => loadChat(), []);
	const sessionIdRef = useRef<string>("");

	useEffect(() => {
		loadSessionId()
			.then((id) => {
				sessionIdRef.current = id;
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		if (hydratedRef.current) return;
		if (persistedMessages === undefined) return;
		hydratedRef.current = true;
		if (persistedMessages.length > 0) {
			setMessages(persistedMessages as ChatMessage[]);
		}
	}, [persistedMessages]);

	const updateMessages = useCallback(
		(updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
			setMessages((prev) => {
				const next =
					typeof updater === "function"
						? (updater as (p: ChatMessage[]) => ChatMessage[])(prev)
						: updater;
				saveChat(next as PersistedChatMessage[]).catch(() => {});
				return next;
			});
		},
		[],
	);

	const updateQuotaFromHeaders = (initResponse: Response) => {
		const limit = initResponse.headers.get("X-RateLimit-Limit");
		const remaining = initResponse.headers.get("X-RateLimit-Remaining");
		const reset = initResponse.headers.get("X-RateLimit-Reset");
		if (!limit || !remaining || !reset) return;
		const resetAtMs = Number.parseInt(reset, 10) * 1000;
		if (!Number.isFinite(resetAtMs)) return;
		setQuota({
			limit: Number.parseInt(limit, 10),
			remaining: Number.parseInt(remaining, 10),
			resetAt: resetAtMs,
		});
	};

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const res = await fetch(`${API_BASE_URL}/api/chat/quota`, {
					method: "GET",
				});
				if (!res.ok) return;
				const data = (await res.json()) as {
					limit: number;
					remaining: number;
					resetAt: string;
				};
				if (cancelled) return;
				const resetAtMs = Date.parse(data.resetAt);
				if (!Number.isFinite(resetAtMs)) return;
				setQuota({
					limit: data.limit,
					remaining: data.remaining,
					resetAt: resetAtMs,
				});
			} catch {
				/* silent */
			}
		};
		load();
		return () => {
			cancelled = true;
		};
	}, []);

	// Auto-scroll to bottom when a new message is sent/received
	useEffect(() => {
		if (!hydratedRef.current) return;
		if (isFirstAutoScroll.current) {
			isFirstAutoScroll.current = false;
			return;
		}
		requestAnimationFrame(() => {
			const el = messagesContainerRef.current;
			if (!el) return;
			el.scrollTo({
				top: el.scrollHeight,
				behavior: "smooth",
			});
		});
	}, [messages.length]);

	const splitDiffLines = (value: string) => {
		const lines = value.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	};

	const wrapTextForDiff = (text: string, maxWidth: number) => {
		const lines = text.split("\n");
		const wrapped: string[] = [];

		lines.forEach((line) => {
			if (line === "") {
				wrapped.push("");
				return;
			}

			const tokens = line.match(/\S+|\s+/g) ?? [line];
			let current = "";

			const pushCurrent = () => {
				wrapped.push(current.replace(/\s+$/g, ""));
				current = "";
			};

			tokens.forEach((token) => {
				if (token.length > maxWidth) {
					if (current) {
						pushCurrent();
					}
					for (let i = 0; i < token.length; i += maxWidth) {
						wrapped.push(token.slice(i, i + maxWidth));
					}
					return;
				}

				if (current.length + token.length <= maxWidth) {
					current += token;
					return;
				}

				pushCurrent();
				current = token.replace(/^\s+/g, "");
			});

			if (current) {
				wrapped.push(current.replace(/\s+$/g, ""));
			}
		});

		return wrapped.join("\n");
	};

	const buildDiff = (original: string, suggested: string): DiffLine[] => {
		const wrapWidth = 96;
		const wrappedOriginal = wrapTextForDiff(original, wrapWidth);
		const wrappedSuggested = wrapTextForDiff(suggested, wrapWidth);
		const changes = diffLines(wrappedOriginal, wrappedSuggested);
		const diff: DiffLine[] = [];
		let pendingRemovals: string[] = [];
		let pendingAdditions: string[] = [];
		let lineId = 0;

		const flushPending = () => {
			const maxLength = Math.max(
				pendingRemovals.length,
				pendingAdditions.length,
			);
			for (let i = 0; i < maxLength; i += 1) {
				const removal = pendingRemovals[i];
				const addition = pendingAdditions[i];
				diff.push({
					id: `diff-${lineId}`,
					original: removal ?? "",
					suggested: addition ?? "",
					originalType: removal !== undefined ? "remove" : "empty",
					suggestedType: addition !== undefined ? "add" : "empty",
				});
				lineId += 1;
			}
			pendingRemovals = [];
			pendingAdditions = [];
		};

		changes.forEach((change) => {
			const lines = splitDiffLines(change.value);
			if (change.added) {
				pendingAdditions.push(...lines);
				return;
			}
			if (change.removed) {
				pendingRemovals.push(...lines);
				return;
			}
			flushPending();
			lines.forEach((line) => {
				diff.push({
					id: `diff-${lineId}`,
					original: line,
					suggested: line,
					originalType: "equal",
					suggestedType: "equal",
				});
				lineId += 1;
			});
		});

		flushPending();
		return diff;
	};

	const handleScroll = useCallback(() => {
		const el = messagesContainerRef.current;
		if (!el) return;
		const { scrollTop, scrollHeight, clientHeight } = el;
		// Only show buttons if content is actually scrollable
		const isScrollable = scrollHeight > clientHeight;
		const isAtTop = scrollTop <= 10;
		const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
		// At the bottom: hide all icons. At the top: only show down. In between: show both.
		setShowScrollTop(isScrollable && !isAtTop && !isAtBottom);
		setShowScrollBottom(isScrollable && !isAtBottom);
		setIsScrolling(true);
		if (hideButtonsTimeoutRef.current) {
			clearTimeout(hideButtonsTimeoutRef.current);
		}
		hideButtonsTimeoutRef.current = setTimeout(() => {
			setIsScrolling(false);
		}, 2000);
	}, []);

	const handleMouseActivity = useCallback(() => {
		setIsScrolling(true);
		if (hideButtonsTimeoutRef.current) {
			clearTimeout(hideButtonsTimeoutRef.current);
		}
		hideButtonsTimeoutRef.current = setTimeout(() => {
			setIsScrolling(false);
		}, 2000);
	}, []);

	const scrollToTop = useCallback(() => {
		messagesContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = messagesContainerRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, []);

	const handleCopy = (content: string, messageId: string) => {
		navigator.clipboard.writeText(content);
		setCopied(messageId);
		setTimeout(() => setCopied(null), 2000);
	};

	const formatReviewAsMarkdown = (
		review: WritingAgentState["review"],
	): string => {
		if (!review) return "No review feedback returned.";

		const sections: { title: string; items?: string[] }[] = [
			{ title: "Issues", items: review.issues },
			{ title: "Missing Elements", items: review.missing_elements },
			{ title: "Tone Mismatches", items: review.tone_mismatches },
			{ title: "Structural Problems", items: review.structural_problems },
			{ title: "Suggested Improvements", items: review.suggested_improvements },
		];

		const body = sections
			.filter((section) => section.items && section.items.length > 0)
			.map(
				(section) =>
					`### ${section.title}\n${section.items
						?.map((item) => `- ${item}`)
						.join("\n")}`,
			)
			.join("\n\n");

		return `## Review Feedback\n\n${body || "No actionable issues found."}`;
	};

	const openDiffReview = (content: string) => {
		setDiffReview({
			original: currentDocument,
			suggested: content,
			diff: buildDiff(currentDocument, content),
		});
	};

	const handleApplyDiff = () => {
		if (!diffReview) return;
		changeDocument(diffReview.suggested);
		setDiffReview(null);
	};

	const handleResetChat = useCallback(async () => {
		if (isLoading) return;
		updateMessages([]);
		setError(null);
		setStreamState(null);
		setStreamTasks([]);
		setDiffReview(null);
		setInputValue("");
		setCopied(null);
		setResetDialogOpen(false);
		try {
			sessionIdRef.current = await resetSessionId();
		} catch {
			/* keep previous session id if persistence fails */
		}
	}, [isLoading, updateMessages]);

	const handleSend = async () => {
		if (!inputValue.trim()) return;
		if (quota?.remaining === 0) return;
		if (quota) {
			setQuota({ ...quota, remaining: Math.max(0, quota.remaining - 1) });
		}
		setIsLoading(true);
		setError(null);
		setStreamState(null);
		setStreamTasks([]);

		const userMessage: ChatMessage = {
			id: Date.now().toString(),
			content: inputValue,
			role: "user",
		};

		updateMessages((prev) => [...prev, userMessage]);
		const promptValue = inputValue;
		setInputValue("");

		try {
			const initResponse = await fetch(`${API_BASE_URL}/api/chat/stream/init`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					userPrompt: promptValue,
					currentDocument,
					sessionId: sessionIdRef.current || undefined,
				}),
			});

			updateQuotaFromHeaders(initResponse);

			if (!initResponse.ok) {
				const errorData = (await initResponse.json().catch(() => ({}))) as {
					error?: string;
					message?: string;
					limit?: number;
					resetAt?: string;
				};
				if (initResponse.status === 429) {
					if (typeof errorData.limit === "number" && errorData.resetAt) {
						const resetAtMs = Date.parse(errorData.resetAt);
						if (Number.isFinite(resetAtMs)) {
							setQuota({
								limit: errorData.limit,
								remaining: 0,
								resetAt: resetAtMs,
							});
						}
					}
					const limit = errorData.limit ?? quota?.limit ?? 5;
					const resetAt = errorData.resetAt
						? new Date(errorData.resetAt).toLocaleString()
						: "later";
					throw new Error(
						`Daily limit reached (${limit} messages). Try again after ${resetAt}.`,
					);
				}
				throw new Error(
					errorData.error || errorData.message || "Failed to initialize stream",
				);
			}

			const { streamId } = (await initResponse.json()) as {
				streamId: string;
			};

			const streamUrl = `${API_BASE_URL}/api/chat/stream?streamId=${encodeURIComponent(
				streamId,
			)}`;
			const eventSource = new EventSource(streamUrl);

			const handleEvent = (payload: MessageEvent) => {
				if (!payload.data) return;
				const parsed = JSON.parse(payload.data) as StreamEvent["data"];
				const event = payload.type as StreamEvent["event"];

				const applyTaskOutputs = (task: WritingTask) => {
					const outputs = task.outputs;
					if (!outputs) return;
					setStreamState((prev) => {
						const nextState: WritingAgentState = {
							...(prev || { userPrompt: promptValue }),
							plan: prev?.plan,
						};
						if (typeof outputs.draft === "string") {
							nextState.draft = outputs.draft;
						}
						if (outputs.review) {
							nextState.review = outputs.review as WritingAgentState["review"];
						}
						if (typeof outputs.finalDocument === "string") {
							nextState.finalDocument = outputs.finalDocument;
						}
						return nextState;
					});
				};

				switch (event) {
					case "plan": {
						const plan = (parsed as { plan: WritingAgentState["plan"] }).plan;
						setStreamState((prev) => ({
							...(prev || { userPrompt: promptValue }),
							plan,
						}));
						setStreamTasks((plan?.tasks || []) as WritingTask[]);
						break;
					}
					case "task_start":
					case "task_update":
					case "task_done": {
						const task = (parsed as { task: WritingTask }).task;
						setStreamTasks((prev) => {
							const existing = prev.find((item) => item.id === task.id);
							if (existing) {
								return prev.map((item) => (item.id === task.id ? task : item));
							}
							return [...prev, task];
						});
						applyTaskOutputs(task);
						break;
					}
					case "final": {
						const finalPayload = parsed as {
							finalDocument?: string;
							state: WritingAgentState;
						};
						const finalState = finalPayload.state;
						setStreamState(finalState);

						const isReviewOnly =
							finalState.plan?.mode === "review" && !finalPayload.finalDocument;
						const contentToUse =
							finalPayload.finalDocument ||
							finalState.finalDocument ||
							finalState.draft;

						const messageContent = isReviewOnly
							? formatReviewAsMarkdown(finalState.review)
							: contentToUse;

						if (!messageContent) break;
						const canReviewDiff = !isReviewOnly;
						const assistantMessage: ChatMessage = {
							id: (Date.now() + 1).toString(),
							content: messageContent,
							role: "assistant",
							stateData: finalState,
							canReviewDiff,
						};
						updateMessages((prev) => [...prev, assistantMessage]);
						setIsLoading(false);
						eventSource.close();
						break;
					}
					case "agent_error": {
						const err = parsed as { message: string };
						setError(err.message);
						setIsLoading(false);
						eventSource.close();
						break;
					}
					default:
						break;
				}
			};

			eventSource.addEventListener("plan", handleEvent);
			eventSource.addEventListener("task_start", handleEvent);
			eventSource.addEventListener("task_update", handleEvent);
			eventSource.addEventListener("task_done", handleEvent);
			eventSource.addEventListener("final", handleEvent);
			eventSource.addEventListener("agent_error", handleEvent);
			eventSource.addEventListener("error", () => {
				setError("Streaming connection failed");
				setIsLoading(false);
				eventSource.close();
			});

			eventSource.addEventListener("done", () => {
				setIsLoading(false);
				eventSource.close();
			});
		} catch (err) {
			const errorMessage = err instanceof Error ? err?.message : "Error!";
			setError(errorMessage);
			setIsLoading(false);
		}
	};

	const activeState = streamState || undefined;
	const activeTasks = streamTasks.length
		? streamTasks
		: activeState?.plan?.tasks || [];

	return (
		<Card className="flex h-full flex-col">
			<CardHeader className="items-center">
				<h2 className="font-semibold text-lg">Agent Chat</h2>
				{messages.length > 0 && (
					<CardAction>
						<Button
							variant="ghost"
							size="sm"
							className="gap-1.5 text-muted-foreground"
							disabled={isLoading}
							onClick={() => setResetDialogOpen(true)}
							aria-label="Reset chat"
							title="Clear chat history"
						>
							<RotateCcw className="size-4" />
							Reset
						</Button>
					</CardAction>
				)}
			</CardHeader>
			<CardContent className="flex flex-1 flex-col justify-between gap-4 overflow-hidden p-0">
				<div className="relative min-h-0 flex-1">
					<div
						ref={messagesContainerRef}
						onScroll={handleScroll}
						onMouseMove={handleMouseActivity}
						onMouseEnter={handleMouseActivity}
						className="thin-scrollbar flex h-full w-full flex-col gap-4 overflow-y-auto p-4"
					>
						{messages.length > 0 ? (
							<AnimatePresence mode="popLayout">
								{messages?.map((message) => (
									<div
										key={message.id}
										className={cn(
											"flex w-full flex-col gap-2",
											message.role === "assistant"
												? "items-start"
												: "items-end",
										)}
									>
										{message.role === "assistant" && message.stateData && (
											<ChainOfThoughtReasoning
												key={message.id}
												isLoading={false}
												stateData={message.stateData}
												animated={false}
											/>
										)}
										<motion.div
											initial={{ opacity: 0, y: 10 }}
											animate={{ opacity: 1, y: 0 }}
											exit={{ opacity: 0, y: -10 }}
											transition={{ duration: 0.3, ease: "easeOut" }}
											className={cn(
												"group flex w-full flex-col gap-2",
												message.role === "user" ? "items-end" : "items-start",
											)}
										>
											<Message
												className={message.role === "assistant" ? "w-full" : ""}
											>
												<MessageContent
													markdown
													className={cn(
														message.role === "user"
															? "bg-primary text-primary-foreground"
															: "bg-primary-foreground dark:bg-secondary-foreground",
													)}
												>
													{message.content}
												</MessageContent>
											</Message>
											<MessageActions>
												<MessageAction tooltip="Copy to clipboard">
													<Button
														variant="ghost"
														size="icon"
														className="h-8 w-8 rounded-full opacity-0 group-hover:opacity-100"
														onClick={() =>
															handleCopy(message.content, message.id)
														}
													>
														<Copy
															className={`size-4 ${copied === message.id ? "text-green-500" : ""}`}
														/>
													</Button>
												</MessageAction>
												{message.role === "assistant" &&
													message.canReviewDiff && (
														<MessageAction tooltip="Compare changes with the document">
															<Button
																variant="ghost"
																size="icon"
																className="w-fit px-2 opacity-0 group-hover:opacity-100"
																onClick={() => openDiffReview(message.content)}
															>
																<CheckLine className="size-4" /> Review Changes
															</Button>
														</MessageAction>
													)}
											</MessageActions>
										</motion.div>
									</div>
								))}
							</AnimatePresence>
						) : (
							<div className="flex h-full w-full flex-col items-center justify-center gap-8 text-center">
								<div className="flex flex-col gap-1">
									<h2 className="font-medium text-xl">
										Experiment your writings with
										<span className="font-semibold"> Wavmo </span>
									</h2>
									<p className="text-accent-foreground/60 text-sm">
										Use suggestions to get started or input your prompt below.{" "}
										<br /> Rate limits may be applied and it will def make
										mistakes.
									</p>
								</div>
								<div className="flex w-[90%] min-w-sm flex-wrap items-center gap-2">
									{promptSuggestions?.map((suggestion) => (
										<PromptSuggestion
											key={suggestion.slice(0, 10)}
											size="lg"
											highlight="true"
											onClick={() => {
												setInputValue(suggestion);
												setTimeout(() => promptInputRef.current?.focus(), 0);
											}}
										>
											{suggestion}
										</PromptSuggestion>
									))}
								</div>
							</div>
						)}

						{isLoading && (
							<ChainOfThoughtReasoning
								isLoading={isLoading}
								stateData={activeState}
								streamTasks={activeTasks}
							/>
						)}
						{error && (
							<SystemMessage variant="error" fill>
								Unable to generate response, seems like a error from our side,
								please try again.
							</SystemMessage>
						)}
					</div>

					{/* Scroll buttons - stacked at bottom-right, show only when scrolling */}
					{isScrolling && (
						<div className="absolute right-4 bottom-4 z-10 flex flex-col gap-1">
							{showScrollTop && (
								<Button
									variant="outline"
									size="icon"
									className="h-7 w-7 rounded-full bg-background/80 shadow-md backdrop-blur-sm hover:bg-background"
									onClick={scrollToTop}
								>
									<ChevronUp className="size-4" />
								</Button>
							)}
							{showScrollBottom && (
								<Button
									variant="outline"
									size="icon"
									className="h-7 w-7 rounded-full bg-background/80 shadow-md backdrop-blur-sm hover:bg-background"
									onClick={scrollToBottom}
								>
									<ChevronDown className="size-4" />
								</Button>
							)}
						</div>
					)}
				</div>

				<div className="relative mx-auto mb-4 w-[85%] min-w-sm">
					{quota && quota.remaining <= 3 && (
						<div className="-translate-x-1/2 -translate-y-[90%] absolute top-0 left-1/2 w-max">
							<QuotaPill quota={quota} />
						</div>
					)}
					<PromptInput
						ref={promptInputRef}
						value={inputValue}
						onValueChange={(value) => setInputValue(value)}
						isLoading={isLoading}
						onSubmit={handleSend}
						className="relative z-10 w-full pt-2"
					>
						<PromptInputTextarea placeholder="Explain, Generate, review your documents..." />
						<PromptInputActions className="justify-end pt-2">
							<PromptInputAction
								tooltip={isLoading ? "Stop generation" : "Send message"}
							>
								<Button
									variant="default"
									size="icon"
									className="h-8 w-8 rounded-full"
									disabled={quota?.remaining === 0}
									onClick={handleSend}
								>
									{isLoading ? (
										<Square className="size-5 fill-current" />
									) : (
										<ArrowUp className="size-5" />
									)}
								</Button>
							</PromptInputAction>
						</PromptInputActions>
					</PromptInput>
				</div>

				<Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Reset chat?</DialogTitle>
							<DialogDescription>
								This clears the conversation history. The document is not
								affected.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => setResetDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button variant="default" onClick={handleResetChat}>
								Reset chat
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{diffReview && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
						<div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl">
							<div className="flex items-start justify-between border-border border-b px-6 py-5">
								<div>
									<h3 className="font-semibold text-xl">Review AI Changes</h3>
									<p className="mt-1 text-muted-foreground text-sm">
										Nothing changes until you approve the suggestion.
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setDiffReview(null)}
								>
									<X className="size-4" />
								</Button>
							</div>

							<div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
								<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-muted/30">
									<div className="sticky top-0 grid border-border border-b bg-card px-4 py-3 font-medium text-sm md:grid-cols-2">
										<div>Original</div>
										<div>Suggested Fix</div>
									</div>
									<div className="thin-scrollbar min-h-0 flex-1 divide-y divide-border overflow-y-auto font-mono text-sm leading-6">
										{diffReview.diff.map((line) => (
											<div key={line.id} className="grid md:grid-cols-2">
												<div
													className={cn(
														"min-h-8 whitespace-pre-wrap border-border px-4 py-2",
														line.originalType === "remove"
															? "bg-red-500/15 text-red-200 line-through"
															: line.originalType === "equal"
																? "text-foreground"
																: "text-muted-foreground",
													)}
												>
													{line.original || " "}
												</div>
												<div
													className={cn(
														"min-h-8 whitespace-pre-wrap border-border px-4 py-2",
														line.suggestedType === "add"
															? "bg-emerald-500/15 text-emerald-200"
															: line.suggestedType === "equal"
																? "text-foreground"
																: "text-muted-foreground",
													)}
												>
													{line.suggested || " "}
												</div>
											</div>
										))}
									</div>
								</div>
							</div>

							<div className="flex items-center justify-between gap-3 border-border border-t px-6 py-4">
								<p className="text-muted-foreground text-sm">
									Apply will replace the current document with the suggested
									version.
								</p>
								<div className="flex items-center gap-2">
									<Button variant="outline" onClick={() => setDiffReview(null)}>
										Cancel
									</Button>
									<Button onClick={handleApplyDiff}>Accept Changes</Button>
								</div>
							</div>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function RelativeCountdown({ ts }: { ts: number }) {
	const [, force] = useState(0);
	useEffect(() => {
		const id = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);
	const diffMs = ts - Date.now();
	if (diffMs <= 0) return <>in a moment</>;
	const totalSeconds = Math.floor(diffMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return (
			<>
				in {hours}h {minutes}m
			</>
		);
	}
	if (minutes > 0) {
		return (
			<>
				in {minutes}m {seconds}s
			</>
		);
	}
	return <>in {seconds}s</>;
}

function QuotaPill({ quota }: { quota: QuotaState }) {
	const { remaining, resetAt } = quota;
	if (remaining <= 0) {
		return (
			<div className="w-fit rounded-t-xl rounded-b-none border border-input border-b-0 bg-background px-4 py-1.5 text-center text-muted-foreground text-sm">
				No messages left — quota refreshes{" "}
				<span className="text-foreground">
					<RelativeCountdown ts={resetAt} />
				</span>
				.
			</div>
		);
	}
	return (
		<div className="w-fit rounded-t-xl rounded-b-none border border-input border-b-0 bg-background px-4 py-1.5 text-center text-muted-foreground text-sm">
			You have {remaining} message{remaining === 1 ? "" : "s"} remaining today!
		</div>
	);
}
