import crypto from 'node:crypto';
import type { Edge, Evidence } from './types';

/* ---------- 导入校验（与新建 / 编辑证据同一套口径） ---------- */

export const MAX_SNAPSHOT_EVIDENCE = 2000;
export const MAX_SNAPSHOT_EDGES = 10000;

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

/* ---------- 快照解析（预览与确认导入共用，保证校验口径完全一致） ---------- */

export interface ParsedSnapshotItem extends EvidenceInput {
  id: string;
  createdAt: string;
}

export interface ParsedSnapshot {
  items: ParsedSnapshotItem[];
  edges: Array<{ fromId: string; toId: string }>;
}

export type SnapshotParseResult =
  | { ok: true; value: ParsedSnapshot }
  | { ok: false; status: 400; message: string };

/**
 * 无 id 卡片的确定性合成 id：同一文件内容重复解析结果稳定，
 * 使「预览 → 确认」两次解析得到相同指纹；前缀 new- 避免与既有 UUID 撞号。
 * 无 id 卡片在差异比较中恒为「新增」（id 不可能存在于当前图）。
 */
function syntheticId(index: number, v: EvidenceInput): string {
  const h = crypto
    .createHash('sha256')
    .update(JSON.stringify({ i: index, ...v }))
    .digest('hex')
    .slice(0, 32);
  return `new-${h}`;
}

export function parseSnapshot(rawBody: unknown, now: string): SnapshotParseResult {
  const body = (rawBody ?? {}) as { evidence?: unknown; edges?: unknown };
  if (!Array.isArray(body?.evidence) || !Array.isArray(body?.edges)) {
    return { ok: false, status: 400, message: '快照格式错误：需要 evidence 与 edges 数组' };
  }
  if (body.evidence.length > MAX_SNAPSHOT_EVIDENCE || body.edges.length > MAX_SNAPSHOT_EDGES) {
    return { ok: false, status: 400, message: '快照过大，已拒绝导入' };
  }

  const items: ParsedSnapshotItem[] = [];
  const seen = new Set<string>();
  body.evidence.forEach((raw, index) => {
    const record = raw as Record<string, unknown> | null;
    const parsed = parseEvidenceInput(record);
    if (!parsed.ok) {
      // 立即中断：用异常携带错误信息，保持与旧接口逐条报错一致
      throw new SnapshotValidationError(`证据「${cleanString(record?.title, 50) || '?'}」：${parsed.message}`);
    }
    const id =
      typeof record?.id === 'string' && record.id ? record.id.slice(0, 64) : syntheticId(index, parsed.value);
    if (seen.has(id)) throw new SnapshotValidationError(`证据 id 重复：${id}`);
    seen.add(id);
    items.push({
      id,
      ...parsed.value,
      createdAt: typeof record?.createdAt === 'string' ? record.createdAt : now,
    });
  });

  const edges: Array<{ fromId: string; toId: string }> = [];
  const edgeSeen = new Set<string>();
  for (const raw of body.edges as Array<Record<string, unknown>>) {
    const fromId = raw?.from ?? raw?.fromId;
    const toId = raw?.to ?? raw?.toId;
    if (typeof fromId !== 'string' || typeof toId !== 'string' || !seen.has(fromId) || !seen.has(toId)) {
      return { ok: false, status: 400, message: '存在指向未知证据的连线，快照已拒绝' };
    }
    const key = `${fromId}->${toId}`;
    if (edgeSeen.has(key)) continue; // 与旧导入一致：重复连线只保留一条
    edgeSeen.add(key);
    edges.push({ fromId, toId });
  }

  return { ok: true, value: { items, edges } };
}

/** 逐条校验可能以异常抛出（标题错误等），路由层统一转 400 */
export class SnapshotValidationError extends Error {}

/* ---------- 差异比较 ---------- */

export interface ImportCardView {
  id: string;
  title: string;
  source: string;
  occurredAt: string | null;
  description: string;
}

export type ImportDiffField = 'title' | 'source' | 'occurredAt' | 'description';

export interface ImportFieldChange {
  field: ImportDiffField;
  before: string;
  after: string;
}

export interface ImportModifiedCard {
  id: string;
  /** 当前标题（标题本身可能被修改，仅用于列表辨识） */
  title: string;
  changes: ImportFieldChange[];
}

export interface ImportEdgeChange {
  fromId: string;
  toId: string;
  fromTitle: string;
  toTitle: string;
}

export interface ImportDiff {
  added: ImportCardView[];
  deleted: ImportCardView[];
  modified: ImportModifiedCard[];
  edgesAdded: ImportEdgeChange[];
  edgesDeleted: ImportEdgeChange[];
  counts: {
    added: number;
    deleted: number;
    modified: number;
    edgesAdded: number;
    edgesDeleted: number;
  };
}

interface CurrentCardView {
  id: string;
  title: string;
  source: string;
  occurredAt: string | null;
  description: string;
}

interface CurrentGraphView {
  evidence: CurrentCardView[];
  edges: Array<{ fromId: string; toId: string }>;
}

const DIFF_FIELDS: ReadonlyArray<ImportDiffField> = ['title', 'source', 'occurredAt', 'description'];

function valueOf(v: CurrentCardView | ParsedSnapshotItem, field: ImportDiffField): string {
  return v[field] ?? '';
}

/**
 * 按证据 id 比较标题、来源、发生时间、描述；连线按两端 id 比较。
 * 无 id 卡片经 parseSnapshot 已得到合成 id（当前图不可能存在），恒为新增。
 */
export function diffSnapshots(current: CurrentGraphView, incoming: ParsedSnapshot): ImportDiff {
  const curById = new Map(current.evidence.map((e) => [e.id, e]));
  const incById = new Map(incoming.items.map((e) => [e.id, e]));

  const toCardView = (e: CurrentCardView | ParsedSnapshotItem): ImportCardView => ({
    id: e.id,
    title: e.title,
    source: e.source,
    occurredAt: e.occurredAt,
    description: e.description,
  });

  const added: ImportCardView[] = [];
  const modified: ImportModifiedCard[] = [];
  for (const inc of incoming.items) {
    const cur = curById.get(inc.id);
    if (!cur) {
      added.push(toCardView(inc));
      continue;
    }
    const changes: ImportFieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const before = valueOf(cur, field);
      const after = valueOf(inc, field);
      if (before !== after) changes.push({ field, before, after });
    }
    if (changes.length > 0) modified.push({ id: cur.id, title: cur.title, changes });
  }
  const deleted: ImportCardView[] = current.evidence
    .filter((e) => !incById.has(e.id))
    .map(toCardView);

  const titleOf = (id: string): string => incById.get(id)?.title ?? curById.get(id)?.title ?? id.slice(0, 8);
  const toEdgeChange = (e: { fromId: string; toId: string }): ImportEdgeChange => ({
    fromId: e.fromId,
    toId: e.toId,
    fromTitle: titleOf(e.fromId),
    toTitle: titleOf(e.toId),
  });

  const curEdgeKeys = new Set(current.edges.map((e) => `${e.fromId}->${e.toId}`));
  const incEdgeKeys = new Set(incoming.edges.map((e) => `${e.fromId}->${e.toId}`));
  const edgesAdded = incoming.edges.filter((e) => !curEdgeKeys.has(`${e.fromId}->${e.toId}`)).map(toEdgeChange);
  const edgesDeleted = current.edges.filter((e) => !incEdgeKeys.has(`${e.fromId}->${e.toId}`)).map(toEdgeChange);

  return {
    added,
    deleted,
    modified,
    edgesAdded,
    edgesDeleted,
    counts: {
      added: added.length,
      deleted: deleted.length,
      modified: modified.length,
      edgesAdded: edgesAdded.length,
      edgesDeleted: edgesDeleted.length,
    },
  };
}

/* ---------- 指纹：把预览结果绑定到「当前图 + 文件内容」 ---------- */

function canonicalJson(graph: CurrentGraphView): string {
  const evidence = graph.evidence
    .map((e) => [e.id, e.title, e.description, e.source, e.occurredAt ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const edges = graph.edges.map((e) => `${e.fromId}->${e.toId}`).sort();
  return JSON.stringify({ evidence, edges });
}

/** 当前图指纹：只纳入差异比较涉及的字段（卡片四字段 + 连线两端 id） */
export function fingerprintGraph(graph: CurrentGraphView): string {
  return crypto.createHash('sha256').update(canonicalJson(graph)).digest('hex');
}

/** 快照指纹：解析规范化后的同口径内容，与图指纹可直接比较 */
export function fingerprintSnapshot(parsed: ParsedSnapshot): string {
  return fingerprintGraph({ evidence: parsed.items, edges: parsed.edges });
}

export function currentGraphView(
  evidence: Evidence[],
  edges: Edge[],
): CurrentGraphView {
  return {
    evidence: evidence.map((e) => ({
      id: e.id,
      title: e.title,
      source: e.source,
      occurredAt: e.occurredAt,
      description: e.description,
    })),
    edges: edges.map((e) => ({ fromId: e.fromId, toId: e.toId })),
  };
}

/* ---------- 预览令牌（无状态 HMAC，绑定两份指纹，确认时防篡改 / 防过期） ---------- */

const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
let tokenSecret: Buffer | null = null;

function getTokenSecret(): Buffer {
  if (!tokenSecret) tokenSecret = crypto.randomBytes(32);
  return tokenSecret;
}

interface PreviewTokenPayload {
  g: string;
  s: string;
  iat: number;
}

export function signPreviewToken(graphFingerprint: string, snapshotFingerprint: string): string {
  const payload = Buffer.from(
    JSON.stringify({ g: graphFingerprint, s: snapshotFingerprint, iat: Date.now() } satisfies PreviewTokenPayload),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', getTokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPreviewToken(
  token: unknown,
): { ok: true; graphFingerprint: string; snapshotFingerprint: string } | { ok: false } {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false };
  const dot = token.lastIndexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getTokenSecret()).update(payload).digest('base64url');
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected))) {
    return { ok: false };
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewTokenPayload;
    if (typeof data.g !== 'string' || typeof data.s !== 'string' || typeof data.iat !== 'number') {
      return { ok: false };
    }
    if (Date.now() - data.iat > PREVIEW_TOKEN_TTL_MS) return { ok: false };
    return { ok: true, graphFingerprint: data.g, snapshotFingerprint: data.s };
  } catch {
    return { ok: false };
  }
}
