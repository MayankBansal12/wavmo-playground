import Dexie, { type Table } from "dexie";
import { welcomeText } from "@/lib/constants/welcome-text";

export type PersistedChatMessage = {
	id: string;
	content: string;
	role: "user" | "assistant";
	stateData?: unknown;
	canReviewDiff?: boolean;
};

type DocumentRow = {
	id: "current";
	content: string;
	updatedAt: number;
};

type ChatRow = {
	id: "current";
	messages: PersistedChatMessage[];
	sessionId: string;
	updatedAt: number;
};

class WavmoDB extends Dexie {
	document!: Table<DocumentRow, "current">;
	chat!: Table<ChatRow, "current">;

	constructor() {
		super("wavmo");
		this.version(1).stores({
			document: "id",
			chat: "id",
		});
	}
}

let _db: WavmoDB | null = null;

function getDB(): WavmoDB {
	if (typeof window === "undefined") {
		throw new Error("WavmoDB is only available in the browser");
	}
	if (!_db) {
		_db = new WavmoDB();
	}
	return _db;
}

const DOCUMENT_ID = "current" as const;
const CHAT_ID = "current" as const;

const corruptedWelcomeSection =
	/(### it writes code examples if required\s*\n+)```(?:ts|typescript)\s*\n(?:\s*\[object Object\]\s*,?)+\s*\n```(\s*\n+### it can handle Math as well)/;

function repairLegacyDocument(content: string): string {
	if (!corruptedWelcomeSection.test(content)) {
		return content;
	}

	const welcomeCodeBlock = welcomeText.match(/```ts\n[\s\S]*?\n```/)?.[0];
	if (!welcomeCodeBlock) return content;

	return content.replace(
		corruptedWelcomeSection,
		(_section, beforeCodeBlock: string, afterCodeBlock: string) =>
			`${beforeCodeBlock}${welcomeCodeBlock}${afterCodeBlock}`,
	);
}

export async function loadDocument(): Promise<string | undefined> {
	const row = await getDB().document.get(DOCUMENT_ID);
	if (!row) return undefined;

	// `loadDocument` is used by `useLiveQuery`, whose querier runs in a
	// read-only Dexie transaction. Keep this path read-only and persist any
	// legacy repair from `ensureSeeded` instead.
	return repairLegacyDocument(row.content);
}

export async function saveDocument(content: string): Promise<void> {
	await getDB().document.put({
		id: DOCUMENT_ID,
		content,
		updatedAt: Date.now(),
	});
}

export async function loadChat(): Promise<PersistedChatMessage[] | undefined> {
	const row = await getDB().chat.get(CHAT_ID);
	return row?.messages;
}

export async function saveChat(
	messages: PersistedChatMessage[],
): Promise<void> {
	const db = getDB();
	await db.transaction("rw", db.chat, async () => {
		const existing = await db.chat.get(CHAT_ID);
		await db.chat.update(CHAT_ID, {
			messages,
			updatedAt: Date.now(),
		});
		if (!existing) {
			await db.chat.put({
				id: CHAT_ID,
				messages,
				sessionId: crypto.randomUUID(),
				updatedAt: Date.now(),
			});
		}
	});
}

export async function loadSessionId(): Promise<string> {
	const db = getDB();
	return db.transaction("rw", db.chat, async () => {
		const existing = await db.chat.get(CHAT_ID);
		if (existing?.sessionId) return existing.sessionId;

		const sessionId = crypto.randomUUID();
		await db.chat.put({
			id: CHAT_ID,
			messages: existing?.messages ?? [],
			sessionId,
			updatedAt: Date.now(),
		});
		return sessionId;
	});
}

export async function resetSessionId(): Promise<string> {
	const db = getDB();
	const sessionId = crypto.randomUUID();
	await db.transaction("rw", db.chat, async () => {
		const updated = await db.chat.update(CHAT_ID, {
			sessionId,
			updatedAt: Date.now(),
		});
		if (!updated) {
			await db.chat.put({
				id: CHAT_ID,
				messages: [],
				sessionId,
				updatedAt: Date.now(),
			});
		}
	});
	return sessionId;
}

let seeded = false;
export async function ensureSeeded(): Promise<void> {
	if (seeded) return;
	const db = getDB();
	await db.transaction("rw", db.document, db.chat, async () => {
		const [doc, chat] = await Promise.all([
			db.document.get(DOCUMENT_ID),
			db.chat.get(CHAT_ID),
		]);
		const now = Date.now();

		if (!doc) {
			await db.document.put({
				id: DOCUMENT_ID,
				content: welcomeText,
				updatedAt: now,
			});
		} else {
			const repairedDocument = repairLegacyDocument(doc.content);
			if (repairedDocument !== doc.content) {
				await db.document.put({
					...doc,
					content: repairedDocument,
					updatedAt: now,
				});
			}
		}

		if (!chat) {
			await db.chat.put({
				id: CHAT_ID,
				messages: [],
				sessionId: crypto.randomUUID(),
				updatedAt: now,
			});
		}
	});
	seeded = true;
}
