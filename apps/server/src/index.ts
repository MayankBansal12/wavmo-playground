import fastifyCors from "@fastify/cors";
import { randomUUID } from "crypto";
import "dotenv/config";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { getClientIp } from "./lib/clientIp";
import { getRedis } from "./lib/redis";
import { buildRateLimit, peekRateLimit } from "./middleware/rateLimit";
import { runWritingWorkflow } from "./network";

const baseCorsConfig = {
	origin: process.env.CORS_ORIGIN || "",
	methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
	credentials: true,
	maxAge: 86400,
};

const fastify = Fastify({
	logger: true,
	trustProxy: true,
});

fastify.register(fastifyCors, baseCorsConfig);

const rateLimitOptions = {
	defaultLimit: Number.parseInt(process.env.RATE_LIMIT_DEFAULT || "10", 10),
	windowSeconds: Number.parseInt(
		process.env.RATE_LIMIT_WINDOW_SECONDS || "86400",
		10,
	),
	bypassDefaultLimit: Number.parseInt(
		process.env.RATE_LIMIT_BYPASS_DEFAULT_LIMIT || "200",
		10,
	),
};

const rateLimit = buildRateLimit(rateLimitOptions);

const normalizeSessionId = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return /^[a-zA-Z0-9_-]{8,128}$/.test(trimmed) ? trimmed : undefined;
};

fastify.get("/api/chat/quota", async (request, reply) => {
	let redis: Redis;
	try {
		redis = getRedis();
	} catch (error) {
		request.log.error(
			{ err: error },
			"quota route: REDIS_URL missing, failing closed",
		);
		return reply.status(503).send({
			error: "rate_limit_unavailable",
			message:
				"Rate limiting is temporarily unavailable. Please retry shortly.",
		});
	}

	const ip = getClientIp(request);
	try {
		const info = await peekRateLimit(redis, ip, rateLimitOptions);
		reply.header("X-RateLimit-Limit", String(info.limit));
		reply.header("X-RateLimit-Remaining", String(info.remaining));
		reply.header("X-RateLimit-Reset", String(Math.floor(info.resetAt / 1000)));
		return reply.send({
			limit: info.limit,
			remaining: info.remaining,
			resetAt: new Date(info.resetAt).toISOString(),
		});
	} catch (error) {
		request.log.error({ err: error, ip }, "quota route: redis error");
		return reply.status(503).send({
			error: "rate_limit_unavailable",
			message:
				"Rate limiting is temporarily unavailable. Please retry shortly.",
		});
	}
});

fastify.post("/api/chat", { preHandler: rateLimit }, async (request, reply) => {
	try {
		const { userPrompt, currentDocument, sessionId } = request.body as {
			userPrompt: string;
			currentDocument?: string;
			sessionId?: string;
		};
		if (!userPrompt) {
			return reply.status(400).send({
				error: "userPrompt is required",
			});
		}

		const agentResponse = await runWritingWorkflow(
			userPrompt,
			currentDocument,
			{
				sessionId: normalizeSessionId(sessionId),
			},
		);
		if (!agentResponse) {
			return reply.status(500).send({
				error: "",
			});
		}

		return agentResponse;
	} catch (error) {
		fastify.log.error(error);
		return reply.status(500).send({
			error: "Internal server error",
			message: error instanceof Error ? error.message : "Unknown error",
		});
	}
});

const streamQueue = new Map<
	string,
	{
		userPrompt: string;
		currentDocument?: string;
		sessionId?: string;
	}
>();

fastify.post(
	"/api/chat/stream/init",
	{ preHandler: rateLimit },
	async (request, reply) => {
		const { userPrompt, currentDocument, sessionId } = request.body as {
			userPrompt: string;
			currentDocument?: string;
			sessionId?: string;
		};
		if (!userPrompt) {
			return reply.status(400).send({ error: "userPrompt is required" });
		}

		const streamId = randomUUID();
		streamQueue.set(streamId, {
			userPrompt,
			currentDocument,
			sessionId: normalizeSessionId(sessionId),
		});
		fastify.log.info(
			{
				route: "/api/chat/stream/init",
				streamId,
				promptLength: userPrompt.length,
				hasCurrentDocument: Boolean(currentDocument),
				queueSize: streamQueue.size,
			},
			"chat stream initialized",
		);
		return reply.send({ streamId });
	},
);

fastify.get("/api/chat/stream", async (request, reply) => {
	const { streamId } = request.query as { streamId?: string };
	if (!streamId) {
		return reply.status(400).send({ error: "streamId is required" });
	}

	const queued = streamQueue.get(streamId);
	if (!queued) {
		fastify.log.warn(
			{ route: "/api/chat/stream", streamId, queueSize: streamQueue.size },
			"chat stream requested with missing streamId",
		);
		return reply.status(404).send({ error: "streamId not found" });
	}
	streamQueue.delete(streamId);
	const startedAt = Date.now();
	fastify.log.info(
		{
			route: "/api/chat/stream",
			streamId,
			queueSize: streamQueue.size,
			promptLength: queued.userPrompt.length,
			hasCurrentDocument: Boolean(queued.currentDocument),
		},
		"chat stream execution started",
	);

	const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3001";

	reply.raw.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": corsOrigin,
		"Access-Control-Allow-Credentials": "true",
		Vary: "Origin",
		"X-Accel-Buffering": "no",
	});
	if (typeof reply.raw.flushHeaders === "function") {
		reply.raw.flushHeaders();
	}
	reply.raw.write("\n");
	fastify.log.info(
		{ route: "/api/chat/stream", streamId },
		"sse connection opened and headers flushed",
	);

	let connectionClosed = false;
	const handleClientClose = () => {
		if (connectionClosed) return;
		connectionClosed = true;
		fastify.log.info(
			{
				route: "/api/chat/stream",
				streamId,
				durationMs: Date.now() - startedAt,
			},
			"client closed sse connection",
		);
	};
	request.raw.on("close", handleClientClose);
	request.raw.on("aborted", handleClientClose);

	const sendEvent = (event: string, data: unknown) => {
		fastify.log.info(
			{
				route: "/api/chat/stream",
				streamId,
				event,
			},
			"sse event streamed to client",
		);
		reply.raw.write(`event: ${event}\n`);
		reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	try {
		fastify.log.info(
			{ route: "/api/chat/stream", streamId },
			"streaming workflow execution starting",
		);
		await runWritingWorkflow(
			queued.userPrompt,
			queued.currentDocument,
			{
				streamId,
				sessionId: queued.sessionId,
				log: fastify.log,
			},
			(event) => {
				sendEvent(event.event, event.data);
			},
		);
		fastify.log.info(
			{
				route: "/api/chat/stream",
				streamId,
				durationMs: Date.now() - startedAt,
			},
			"streaming workflow completed",
		);
		reply.raw.write("event: done\n");
		reply.raw.write("data: {}\n\n");
		fastify.log.info(
			{ route: "/api/chat/stream", streamId },
			"sse done event sent",
		);
		reply.raw.end();
	} catch (error) {
		fastify.log.error(
			{
				route: "/api/chat/stream",
				streamId,
				durationMs: Date.now() - startedAt,
				error,
			},
			"chat stream failed",
		);
		sendEvent("agent_error", {
			message: error instanceof Error ? error.message : "Unknown error",
		});
		reply.raw.end();
	}
});

fastify.get("/health", async () => {
	return "Server is healthy!";
});

const host = "RENDER" in process.env ? "0.0.0.0" : "localhost";
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8000;
fastify.listen({ host, port: PORT }, (err, address) => {
	if (err) {
		fastify.log.error(err);
		process.exit(1);
	}
	console.log(`Server listening at ${address}`);
});
