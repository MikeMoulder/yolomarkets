/**
 * Draft store for the Telegram `/create` wizard.
 *
 * Each in-flight market creation is one `telegram_market_drafts` row. The
 * webhook handles every Telegram update as an isolated request, so this table
 * is what makes a multi-message conversation possible — and what stops a
 * double-tapped confirm button from deploying twice.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { telegramMarketDrafts, type TelegramMarketDraftRow } from "./db/schema";

export type DraftStep =
    | "question"
    | "deadline"
    | "seed"
    | "category"
    | "criteria"
    | "image"
    | "confirm"
    | "deploying"
    | "done"
    | "failed"
    | "cancelled";

/** Steps where the wizard is still waiting on the admin. Anything else is a
 *  terminal state (or mid-deploy) and must not absorb the next chat message. */
const OPEN_STEPS: DraftStep[] = [
    "question",
    "deadline",
    "seed",
    "category",
    "criteria",
    "image",
    "confirm",
];

/** Steps whose next input is free text typed into the chat. `confirm` and
 *  `image` are not among them — those cards are driven by buttons and photos. */
const TEXT_INPUT_STEPS: DraftStep[] = [
    "question",
    "deadline",
    "seed",
    "category",
    "criteria",
];

export type MarketDraft = {
    id: string;
    chatId: string;
    userId: string | null;
    step: DraftStep;
    question: string | null;
    category: string | null;
    criteria: string | null;
    deadline: bigint | null;
    seedUsdc: number | null;
    cardMessageId: number | null;
    marketAddress: string | null;
    txHash: string | null;
    error: string | null;
    /** Cover art, held until the deploy tx mints an address to key it by. */
    imageData: Buffer | null;
    imageMime: string | null;
    imageSize: number | null;
};

export type DraftPatch = Partial<Omit<MarketDraft, "id" | "chatId" | "userId">>;

function rowToDraft(r: TelegramMarketDraftRow): MarketDraft {
    return {
        id: r.id,
        chatId: r.chatId,
        userId: r.userId,
        step: r.step as DraftStep,
        question: r.question,
        category: r.category,
        criteria: r.criteria,
        deadline: r.deadline,
        seedUsdc: r.seedUsdc === null ? null : Number(r.seedUsdc),
        cardMessageId: r.cardMessageId,
        marketAddress: r.marketAddress,
        txHash: r.txHash,
        error: r.error,
        imageData: r.imageData ?? null,
        imageMime: r.imageMime,
        imageSize: r.imageSize,
    };
}

function patchToRow(patch: DraftPatch) {
    return {
        ...(patch.step !== undefined ? { step: patch.step } : {}),
        ...(patch.question !== undefined ? { question: patch.question } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
        ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
        ...(patch.seedUsdc !== undefined
            ? { seedUsdc: patch.seedUsdc === null ? null : String(patch.seedUsdc) }
            : {}),
        ...(patch.cardMessageId !== undefined ? { cardMessageId: patch.cardMessageId } : {}),
        ...(patch.marketAddress !== undefined ? { marketAddress: patch.marketAddress } : {}),
        ...(patch.txHash !== undefined ? { txHash: patch.txHash } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.imageData !== undefined ? { imageData: patch.imageData } : {}),
        ...(patch.imageMime !== undefined ? { imageMime: patch.imageMime } : {}),
        ...(patch.imageSize !== undefined ? { imageSize: patch.imageSize } : {}),
        updatedAt: new Date(),
    };
}

export function isTextInputStep(step: DraftStep): boolean {
    return TEXT_INPUT_STEPS.includes(step);
}

/** Start a fresh draft, cancelling whatever the chat had open. Only one
 *  `/create` per chat at a time — two half-built markets sharing one text
 *  stream would be unusable. */
export async function startDraft(
    chatId: string,
    userId: string | null,
    seed: DraftPatch = {},
): Promise<MarketDraft> {
    await cancelOpenDrafts(chatId);
    const id = randomBytes(5).toString("hex"); // 10 chars — fits callback_data
    const [row] = await db
        .insert(telegramMarketDrafts)
        .values({
            id,
            chatId,
            userId,
            step: seed.step ?? "question",
            question: seed.question ?? null,
            category: seed.category ?? null,
            criteria: seed.criteria ?? null,
            deadline: seed.deadline ?? null,
            seedUsdc: seed.seedUsdc === undefined || seed.seedUsdc === null ? null : String(seed.seedUsdc),
        })
        .returning();
    return rowToDraft(row);
}

export async function getDraft(id: string): Promise<MarketDraft | null> {
    const [row] = await db
        .select()
        .from(telegramMarketDrafts)
        .where(eq(telegramMarketDrafts.id, id))
        .limit(1);
    return row ? rowToDraft(row) : null;
}

/** The chat's live draft, if any — the one a plain text message belongs to. */
export async function getOpenDraft(chatId: string): Promise<MarketDraft | null> {
    const [row] = await db
        .select()
        .from(telegramMarketDrafts)
        .where(
            and(
                eq(telegramMarketDrafts.chatId, chatId),
                inArray(telegramMarketDrafts.step, OPEN_STEPS),
            ),
        )
        .orderBy(desc(telegramMarketDrafts.updatedAt))
        .limit(1);
    return row ? rowToDraft(row) : null;
}

export async function patchDraft(id: string, patch: DraftPatch): Promise<MarketDraft | null> {
    const [row] = await db
        .update(telegramMarketDrafts)
        .set(patchToRow(patch))
        .where(eq(telegramMarketDrafts.id, id))
        .returning();
    return row ? rowToDraft(row) : null;
}

/** Atomically take a draft from `confirm` → `deploying`. Returns null when
 *  another request already claimed it, which is what makes a double-tapped
 *  "Create" button (or a Telegram webhook retry) harmless. */
export async function claimDraftForDeploy(id: string): Promise<MarketDraft | null> {
    const [row] = await db
        .update(telegramMarketDrafts)
        .set({ step: "deploying", error: null, updatedAt: new Date() })
        .where(and(eq(telegramMarketDrafts.id, id), eq(telegramMarketDrafts.step, "confirm")))
        .returning();
    return row ? rowToDraft(row) : null;
}

/** Cheap connectivity check used at bot boot. Throws if the drafts table isn't
 *  reachable, so a misconfigured process dies instead of answering every
 *  `/create` with a DB error. */
export async function probeDraftStore(): Promise<void> {
    await db.select({ id: telegramMarketDrafts.id }).from(telegramMarketDrafts).limit(1);
}

export async function cancelOpenDrafts(chatId: string): Promise<number> {
    const rows = await db
        .update(telegramMarketDrafts)
        .set({ step: "cancelled", updatedAt: new Date() })
        .where(
            and(
                eq(telegramMarketDrafts.chatId, chatId),
                inArray(telegramMarketDrafts.step, OPEN_STEPS),
            ),
        )
        .returning({ id: telegramMarketDrafts.id });
    return rows.length;
}
