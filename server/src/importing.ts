import crypto from 'node:crypto';
import type { EdgeLike } from './graph';
import type { Evidence } from './types';

/* ---------- 快照规模上限 ---------- */

export const MAX_EVIDENCE = 2000;
export const MAX_EDGES = 10000;

/* ---------- 字段清洗与卡片输入校验（与单卡增改接口同一套口径） ---------- */

export interface EvidenceInput {
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

export function cleanString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function parseEvidenceInput(body: unknown): { ok: true; value: EvidenceInput } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = cleanString(b.title, 200);
  if (!title) return { ok: false, message: '标题不能为空' };
  let occurredAt: string | null = null;
  if (typeof b.occurredAt === 'string' && b.occurredAt.trim()) {
    const t = b.occurredAt.trim();
    if (Number.isNaN(Date.parse(t))) return { ok: false, message: '发生时间格式无效' };
    occurredAt = t;
  }
  return {
    ok: true,
    value: {
      title,
      description: cleanString(b.description, 2000),
      source: cleanString(b.source, 200),
      occurredAt,
    },
  };
}

/* ---------- 快照解析（导入与差异预览共用） ---------- */

export interface SnapshotCard {
  id: string;
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
  createdAt: string;
  /** 快照原文件中是否带 id；无 id 卡片一律视为新增卡片 */
  hadId: boolean;
}

export type SnapshotEdge = EdgeLike;

export type ParseSnapshotResult =
  | { ok: true; cards: SnapshotCard[]; edges: SnapshotEdge[] }
  | { ok: false; message: string };

/**
 * 解析并校验整份快照：结构、字段、id 重复、连线端点均校验；
 * 无 id 的卡片在此分配新 id（预览与确认各自分配，因其本来就按新增处理、
 * 也不可能被连线端点引用）。调用方还需用 findCycle 做整体环校验。
 */
export function parseSnapshot(body: unknown, now: string): ParseSnapshotResult {
  const b = (body ?? {}) as { evidence?: unknown; edges?: unknown };
  if (!Array.isArray(b.evidence) || !Array.isArray(b.edges)) {
    return { ok: false, message: '快照格式错误：需要 evidence 与 edges 数组' };
  }
  if (b.evidence.length > MAX_EVIDENCE || b.edges.length > MAX_EDGES) {
    return { ok: false, message: '快照过大，已拒绝导入' };
  }

  const cards: SnapshotCard[] = [];
  const seen = new Set<string>();
  for (const raw of b.evidence as Array<Record<string, unknown>>) {
    const parsed = parseEvidenceInput(raw);
    if (!parsed.ok) return { ok: false, message: `证据「${cleanString(raw?.title, 50) || '?'}」：${parsed.message}` };
    const rawId = raw?.id;
    const id = typeof rawId === 'string' && rawId ? rawId.slice(0, 64) : crypto.randomUUID();
    const hadId = typeof rawId === 'string' && !!rawId;
    if (seen.has(id)) return { ok: false, message: `证据 id 重复：${id}` };
    seen.add(id);
    cards.push({
      id,
      ...parsed.value,
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
      hadId,
    });
  }

  const edges: SnapshotEdge[] = [];
  const edgeSeen = new Set<string>();
  for (const raw of b.edges as Array<Record<string, unknown>>) {
    const fromId = raw?.from ?? raw?.fromId;
    const toId = raw?.to ?? raw?.toId;
    if (typeof fromId !== 'string' || typeof toId !== 'string' || !seen.has(fromId) || !seen.has(toId)) {
      return { ok: false, message: '存在指向未知证据的连线，快照已拒绝' };
    }
    const key = `${fromId}->${toId}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ fromId, toId });
  }

  return { ok: true, cards, edges };
}

/** 把解析后的卡片转为落库行（updatedAt 统一刷新） */
export function toEvidenceRows(cards: SnapshotCard[], now: string): Evidence[] {
  return cards.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    source: c.source,
    occurredAt: c.occurredAt,
    createdAt: c.createdAt,
    updatedAt: now,
  }));
}

/* ---------- 差异预览 ---------- */

export type ImportFieldName = 'title' | 'source' | 'occurredAt' | 'description';

export interface ImportFieldChange {
  field: ImportFieldName;
  /** 变更前文本（发生时间为空时为空串） */
  before: string;
  /** 变更后文本 */
  after: string;
}

export interface ImportCardRef {
  id: string;
  title: string;
}

export interface ImportModifiedCard extends ImportCardRef {
  changes: ImportFieldChange[];
}

export interface ImportEdgeRef {
  fromId: string;
  toId: string;
  fromTitle: string;
  toTitle: string;
}

export interface ImportDiff {
  addedCards: ImportCardRef[];
  removedCards: ImportCardRef[];
  modifiedCards: ImportModifiedCard[];
  addedEdges: ImportEdgeRef[];
  removedEdges: ImportEdgeRef[];
  counts: {
    addedCards: number;
    removedCards: number;
    modifiedCards: number;
    addedEdges: number;
    removedEdges: number;
  };
}

interface DiffCardLike {
  id: string;
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

const DIFF_FIELDS: Array<{ key: ImportFieldName; get: (c: DiffCardLike) => string }> = [
  { key: 'title', get: (c) => c.title },
  { key: 'source', get: (c) => c.source },
  { key: 'occurredAt', get: (c) => c.occurredAt ?? '' },
  { key: 'description', get: (c) => c.description },
];

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpCardRef = (a: ImportCardRef, b: ImportCardRef): number =>
  cmpText(a.title, b.title) || cmpText(a.id, b.id);

/**
 * 按证据 id 比较标题、来源、发生时间、描述；无 id（hadId=false）的快照卡片
 * 不可能与当前图 id 重合，自然全部落入新增集合。连线按两端 id 配对比较。
 */
export function computeImportDiff(
  current: { evidence: DiffCardLike[]; edges: EdgeLike[] },
  snapshot: { cards: DiffCardLike[]; edges: EdgeLike[] },
): ImportDiff {
  const currentById = new Map(current.evidence.map((e) => [e.id, e]));
  const incomingById = new Map(snapshot.cards.map((e) => [e.id, e]));

  const addedCards: ImportCardRef[] = [];
  const removedCards: ImportCardRef[] = [];
  const modifiedCards: ImportModifiedCard[] = [];

  for (const card of snapshot.cards) {
    const old = currentById.get(card.id);
    if (!old) {
      addedCards.push({ id: card.id, title: card.title });
      continue;
    }
    const changes: ImportFieldChange[] = [];
    for (const { key, get } of DIFF_FIELDS) {
      const before = get(old);
      const after = get(card);
      if (before !== after) changes.push({ field: key, before, after });
    }
    if (changes.length > 0) modifiedCards.push({ id: card.id, title: card.title, changes });
  }
  for (const card of current.evidence) {
    if (!incomingById.has(card.id)) removedCards.push({ id: card.id, title: card.title });
  }

  const currentTitle = new Map(current.evidence.map((e) => [e.id, e.title]));
  const incomingTitle = new Map(snapshot.cards.map((e) => [e.id, e.title]));
  const fallbackTitle = (id: string): string => id.slice(0, 8);

  const currentEdgeKeys = new Set(current.edges.map((e) => `${e.fromId}->${e.toId}`));
  const incomingEdgeKeys = new Set(snapshot.edges.map((e) => `${e.fromId}->${e.toId}`));

  const toEdgeRef = (key: string, titles: Map<string, string>): ImportEdgeRef => {
    const sep = key.indexOf('->');
    const fromId = key.slice(0, sep);
    const toId = key.slice(sep + 2);
    return {
      fromId,
      toId,
      fromTitle: titles.get(fromId) ?? fallbackTitle(fromId),
      toTitle: titles.get(toId) ?? fallbackTitle(toId),
    };
  };

  const addedEdges = [...incomingEdgeKeys]
    .filter((k) => !currentEdgeKeys.has(k))
    .map((k) => toEdgeRef(k, incomingTitle));
  const removedEdges = [...currentEdgeKeys]
    .filter((k) => !incomingEdgeKeys.has(k))
    .map((k) => toEdgeRef(k, currentTitle));

  addedCards.sort(cmpCardRef);
  removedCards.sort(cmpCardRef);
  modifiedCards.sort(cmpCardRef);
  const cmpEdge = (a: ImportEdgeRef, b: ImportEdgeRef): number =>
    cmpText(a.fromTitle, b.fromTitle) || cmpText(a.toTitle, b.toTitle) ||
    cmpText(a.fromId, b.fromId) || cmpText(a.toId, b.toId);
  addedEdges.sort(cmpEdge);
  removedEdges.sort(cmpEdge);

  return {
    addedCards,
    removedCards,
    modifiedCards,
    addedEdges,
    removedEdges,
    counts: {
      addedCards: addedCards.length,
      removedCards: removedCards.length,
      modifiedCards: modifiedCards.length,
      addedEdges: addedEdges.length,
      removedEdges: removedEdges.length,
    },
  };
}

/* ---------- 预览绑定：当前图指纹 + 文件内容哈希 + 一次性令牌 ---------- */

/**
 * 当前图指纹：仅参与导入语义的字段（id、标题、来源、发生时间、描述）与
 * 连线端点配对；createdAt/updatedAt/边 rowid 变化不影响导入覆盖语义。
 */
export function graphFingerprint(evidence: DiffCardLike[], edges: EdgeLike[]): string {
  const cards = evidence
    .map((e) => ({ id: e.id, title: e.title, source: e.source, occurredAt: e.occurredAt, description: e.description }))
    .sort((a, b) => cmpText(a.id, b.id));
  const edgeKeys = edges.map((e) => `${e.fromId}->${e.toId}`).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ cards, edges: edgeKeys })).digest('hex');
}

/** 文件内容指纹：直接对原始文件文本取哈希，保证「绑定文件内容」 */
export function snapshotHash(snapshotText: string): string {
  return crypto.createHash('sha256').update(snapshotText, 'utf8').digest('hex');
}

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_PENDING_PREVIEWS = 50;

interface PendingPreview {
  fileHash: string;
  graphFp: string;
  createdAt: number;
}

const pendingPreviews = new Map<string, PendingPreview>();

/** 登记一次差异预览，返回一次性确认令牌 */
export function createPreviewToken(fileHash: string, graphFp: string): string {
  const now = Date.now();
  for (const [token, p] of pendingPreviews) {
    if (now - p.createdAt > PREVIEW_TTL_MS) pendingPreviews.delete(token);
  }
  if (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
    let oldestToken: string | null = null;
    for (const [token, p] of pendingPreviews) {
      if (oldestToken === null || p.createdAt < pendingPreviews.get(oldestToken)!.createdAt) oldestToken = token;
    }
    if (oldestToken !== null) pendingPreviews.delete(oldestToken);
  }
  const token = crypto.randomUUID();
  pendingPreviews.set(token, { fileHash, graphFp: graphFp, createdAt: now });
  return token;
}

export type PreviewTokenMismatch = 'token-expired' | 'file-changed' | 'graph-changed';

/**
 * 确认时复核：令牌仍有效、文件内容哈希与当前图指纹都与预览时一致。
 * 仅读取登记项；是否消费由调用方按最终结果决定（deletePreviewToken）。
 */
export function checkPreviewToken(
  token: string,
  fileHash: string,
  graphFp: string,
): { ok: true } | { ok: false; reason: PreviewTokenMismatch } {
  const pending = pendingPreviews.get(token);
  if (!pending || Date.now() - pending.createdAt > PREVIEW_TTL_MS) {
    return { ok: false, reason: 'token-expired' };
  }
  if (pending.fileHash !== fileHash) return { ok: false, reason: 'file-changed' };
  if (pending.graphFp !== graphFp) return { ok: false, reason: 'graph-changed' };
  return { ok: true };
}

export function deletePreviewToken(token: string): void {
  pendingPreviews.delete(token);
}
