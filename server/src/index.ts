import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { db, getEdges, getEvidence } from './db';
import { analyzeMustPass, analyzeTimeWindow, cycleAfterAdding, findBypassPath, findCycle, findRedundantEdges, mergeConflict, planMergeEdges, planPrune, queryOrder, topoLevels } from './graph';
import { resetWithSample, seedIfEmpty } from './seed';
import {
  SnapshotValidationError,
  currentGraphView,
  diffSnapshots,
  fingerprintGraph,
  fingerprintSnapshot,
  parseEvidenceInput,
  parseSnapshot,
  signPreviewToken,
  verifyPreviewToken,
} from './snapshot';
import type { BypassPathResult, GraphState, ImportPreview, MustPassResult, OrderQueryResult, OrderWitness, PruneResult, RedundancyReport, TimeWindowResult } from './types';

const app = express();
app.use(express.json({ limit: '5mb' }));

/* ---------- 状态组装 ---------- */

function buildState(): GraphState {
  const evidence = getEvidence();
  const edges = getEdges();
  const levels = topoLevels(evidence.map((e) => e.id), edges) ?? {};
  const levelCount = Object.values(levels).reduce((m, l) => Math.max(m, l + 1), 0);
  return { evidence, edges, levels, levelCount };
}

/* ---------- 时间窗口分析的时间口径 ---------- */

const MINUTE = 60_000;
const MAX_GAP_MINUTES = 1_000_000;

/**
 * 解析时间为「墙钟毫秒数」：
 * - 无时区时间（如 2026-03-12T02:15，datetime-local）按其字面值直接取墙钟时间；
 * - 带 Z 或偏移量的时间先换算到同一墙钟坐标（toISOString 后去掉时区部分）。
 * 这样同一面板内事故区间、固定时刻、传播计算全部在统一的墙钟轴上完成，
 * 不受服务器所在时区影响。非法时间返回 null。
 */
export function parseWallTimeMs(raw: string): number | null {
  const s = raw.trim();
  let naive = s;
  const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  if (hasZone) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    naive = new Date(t).toISOString().slice(0, -1); // 去掉结尾 Z
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(naive);
  if (!m) {
    // 兼容其他可被 JS 识别的无时区输入：Date 构造按本地时区解析，按分钟取整
    const fallback = Date.parse(s);
    return Number.isNaN(fallback) ? null : Math.floor(fallback / MINUTE) * MINUTE;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day || dt.getUTCFullYear() !== year) return null;
  return dt.getTime();
}

/** 墙钟毫秒数 → 分钟精度字符串（YYYY-MM-DDTHH:mm），用于结果回传，不做时区换算 */
function formatWallMinute(t: number): string {
  const iso = new Date(Math.floor(t / MINUTE) * MINUTE).toISOString();
  return iso.slice(0, 16);
}

/* ---------- 证据卡片 ---------- */

app.get('/api/state', (_req, res) => {
  res.json(buildState());
});

app.post('/api/evidence', (req, res) => {
  const parsed = parseEvidenceInput(req.body);
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO evidence (id, title, description, source, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), parsed.value.title, parsed.value.description, parsed.value.source, parsed.value.occurredAt, now, now);
  res.status(201).json(buildState());
});

app.put('/api/evidence/:id', (req, res) => {
  const parsed = parseEvidenceInput(req.body);
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });
  const r = db
    .prepare('UPDATE evidence SET title = ?, description = ?, source = ?, occurred_at = ?, updated_at = ? WHERE id = ?')
    .run(parsed.value.title, parsed.value.description, parsed.value.source, parsed.value.occurredAt, new Date().toISOString(), req.params.id);
  if (r.changes === 0) return res.status(404).json({ message: '证据卡片不存在' });
  res.json(buildState());
});

app.delete('/api/evidence/:id', (req, res) => {
  const r = db.prepare('DELETE FROM evidence WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ message: '证据卡片不存在' });
  res.json(buildState());
});

/* ---------- 重复证据合并 ---------- */

/**
 * 事务内若发现合并冲突（自环 / 有向环）则抛出该错误，
 * better-sqlite3 会整体回滚，保证不留下任何半截改接。
 */
class MergeConflictError extends Error {
  conflict: { kind: 'self-loop' | 'cycle'; path: string[] };
  constructor(conflict: { kind: 'self-loop' | 'cycle'; path: string[] }) {
    super('merge conflict');
    this.conflict = conflict;
  }
}

app.post('/api/evidence/merge', (req, res) => {
  const { sourceId, targetId } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') {
    return res.status(400).json({ message: 'sourceId 与 targetId 均为必填' });
  }
  if (sourceId === targetId) {
    return res.status(400).json({ message: '源卡片与保留卡片不能是同一张卡片' });
  }
  const ids = new Set(getEvidence().map((e) => e.id));
  if (!ids.has(sourceId) || !ids.has(targetId)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }

  const tx = db.transaction(() => {
    // 事务内校验：改接会产生自环或有向环时记录冲突路径并整体回滚
    const conflict = mergeConflict(getEdges(), sourceId, targetId);
    if (conflict) throw new MergeConflictError(conflict);

    // 源卡的全部入边、出边改接到保留卡；重复连线只留一条（删除源侧那条）
    const { deleteIds, rewire } = planMergeEdges(getEdges(), sourceId, targetId);
    const delEdge = db.prepare('DELETE FROM edges WHERE id = ?');
    for (const id of deleteIds) delEdge.run(id);
    const moveEdge = db.prepare('UPDATE edges SET from_id = ?, to_id = ? WHERE id = ?');
    for (const e of rewire) moveEdge.run(e.fromId, e.toId, e.id);

    // 最后删除源卡（保留卡的标题、来源、时间、描述均不改动）
    db.prepare('DELETE FROM evidence WHERE id = ?').run(sourceId);
  });

  try {
    tx();
  } catch (e) {
    if (e instanceof MergeConflictError) {
      const message =
        e.conflict.kind === 'self-loop'
          ? '合并会产生自环约束，已整体拒绝（未做任何改动）'
          : '合并会形成循环依赖，已整体拒绝（未做任何改动）';
      return res.status(409).json({ message, merge: e.conflict, cycle: e.conflict.path });
    }
    throw e;
  }
  res.json(buildState());
});

/* ---------- 「必须早于」连线 ---------- */

app.post('/api/edges', (req, res) => {
  const { fromId, toId } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    return res.status(400).json({ message: 'fromId 与 toId 均为必填' });
  }
  const ids = new Set(getEvidence().map((e) => e.id));
  if (!ids.has(fromId) || !ids.has(toId)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const edges = getEdges();
  if (edges.some((e) => e.fromId === fromId && e.toId === toId)) {
    return res.status(409).json({ message: '该连线已存在' });
  }
  const cycle = cycleAfterAdding(edges, { fromId, toId });
  if (cycle) {
    return res.status(409).json({ message: '该连线会形成循环依赖，已拒绝保存', cycle });
  }
  db.prepare('INSERT INTO edges (from_id, to_id, created_at) VALUES (?, ?, ?)').run(fromId, toId, new Date().toISOString());
  res.status(201).json(buildState());
});

app.delete('/api/edges/:id', (req, res) => {
  const r = db.prepare('DELETE FROM edges WHERE id = ?').run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ message: '连线不存在' });
  res.json(buildState());
});

/* ---------- 约束瘦身（传递约简） ---------- */

app.get('/api/redundancy', (_req, res) => {
  const redundant = findRedundantEdges(getEdges()).map(({ edge, path }) => ({
    edgeId: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    path,
  }));
  const report: RedundancyReport = { redundant };
  res.json(report);
});

app.post('/api/edges/prune', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.edgeIds;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'number' || !Number.isInteger(x))) {
    return res.status(400).json({ message: 'edgeIds 必须为整数数组' });
  }
  const ids = raw as number[];
  // 单个事务：在事务内重新分析「当前仍冗余」的连线并删除，
  // 逐条复核保证每次删除都不改变可达关系（传递闭包不变）
  let plan: { remove: Array<{ id: number }>; skipped: number[] } = { remove: [], skipped: [] };
  const tx = db.transaction(() => {
    plan = planPrune(getEdges(), ids);
    const del = db.prepare('DELETE FROM edges WHERE id = ?');
    for (const e of plan.remove) del.run(e.id);
  });
  tx();
  const result: PruneResult = { ...buildState(), pruned: plan.remove.map((e) => e.id), skipped: plan.skipped };
  res.json(result);
});

/* ---------- 顺序确定性查询 ---------- */

app.get('/api/order-query', (req, res) => {
  const { a, b } = req.query;
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return res.status(400).json({ message: 'a 与 b 两个证据 id 均为必填' });
  }
  if (a === b) {
    return res.status(400).json({ message: '请选择两张不同的证据卡片' });
  }
  const evidence = getEvidence();
  const ids = new Set(evidence.map((e) => e.id));
  if (!ids.has(a) || !ids.has(b)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const edges = getEdges();
  const outcome = queryOrder(
    evidence.map((e) => ({ id: e.id, createdAt: e.createdAt })),
    edges,
    a,
    b,
  );
  if (!outcome) {
    return res.status(409).json({ message: '当前约束图存在环，无法判定顺序' });
  }
  // 未约束时：为每个见证方向计算附加约束后的拓扑层级，供前端临时预览画布布局
  let witnesses: OrderQueryResult['witnesses'] = null;
  if (outcome.witnesses) {
    const allIds = evidence.map((e) => e.id);
    const buildWitness = (firstId: string, secondId: string, order: string[]): OrderWitness => {
      const levels = topoLevels(allIds, [...edges, { fromId: firstId, toId: secondId }]) ?? {};
      return {
        firstId,
        secondId,
        order,
        levels,
        levelCount: Object.values(levels).reduce((m, l) => Math.max(m, l + 1), 0),
      };
    };
    witnesses = {
      aFirst: buildWitness(a, b, outcome.witnesses.aFirst),
      bFirst: buildWitness(b, a, outcome.witnesses.bFirst),
    };
  }
  const result: OrderQueryResult = { aId: a, bId: b, relation: outcome.relation, path: outcome.path, witnesses };
  res.json(result);
});

/* ---------- 必经证据分析（只读） ---------- */

app.get('/api/must-pass', (req, res) => {
  const { a, b } = req.query;
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return res.status(400).json({ message: 'a 与 b 两个证据 id 均为必填' });
  }
  if (a === b) {
    return res.status(400).json({ message: '起点与终点不能是同一张卡片' });
  }
  const evidence = getEvidence();
  const ids = new Set(evidence.map((e) => e.id));
  if (!ids.has(a) || !ids.has(b)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const analysis = analyzeMustPass(
    evidence.map((e) => ({ id: e.id, createdAt: e.createdAt })),
    getEdges(),
    a,
    b,
  );
  if (!analysis) {
    return res.status(409).json({ message: '当前约束图存在环，无法分析必经证据' });
  }
  const result: MustPassResult = { aId: a, bId: b, ...analysis };
  res.json(result);
});

app.get('/api/must-pass/bypass', (req, res) => {
  const { a, b, skip } = req.query;
  if (typeof a !== 'string' || typeof b !== 'string' || typeof skip !== 'string' || !a || !b || !skip) {
    return res.status(400).json({ message: 'a、b 与 skip 三个证据 id 均为必填' });
  }
  if (a === b) {
    return res.status(400).json({ message: '起点与终点不能是同一张卡片' });
  }
  if (skip === a || skip === b) {
    return res.status(400).json({ message: '只能绕开中间卡片，不能绕开起点或终点' });
  }
  const ids = new Set(getEvidence().map((e) => e.id));
  if (!ids.has(a) || !ids.has(b) || !ids.has(skip)) {
    return res.status(404).json({ message: '证据卡片不存在，请刷新后重试' });
  }
  const result: BypassPathResult = { aId: a, bId: b, skipId: skip, path: findBypassPath(getEdges(), a, b, skip) };
  res.json(result);
});

/* ---------- 时间窗口分析（只读） ---------- */

app.get('/api/time-window', (req, res) => {
  const { start, end, gap } = req.query as Record<string, unknown>;
  if (typeof start !== 'string' || typeof end !== 'string') {
    return res.status(400).json({ message: '事故起止时间均为必填（start 与 end）' });
  }
  const windowStartMs = parseWallTimeMs(start);
  const windowEndMs = parseWallTimeMs(end);
  if (windowStartMs === null || windowEndMs === null) {
    return res.status(400).json({ message: '事故起止时间格式无效，请使用合法日期时间（如 2026-03-12T02:00）' });
  }
  if (typeof gap !== 'string' || !/^\d+$/.test(gap)) {
    return res.status(400).json({ message: '最小间隔必须为整数分钟（至少 1 分钟）' });
  }
  const gapMinutes = Number(gap);
  if (!Number.isSafeInteger(gapMinutes) || gapMinutes < 1) {
    return res.status(400).json({ message: '最小间隔必须为至少 1 分钟的整数' });
  }
  if (gapMinutes > MAX_GAP_MINUTES) {
    return res.status(400).json({ message: `最小间隔过大，请输入不超过 ${MAX_GAP_MINUTES} 分钟的整数` });
  }
  if (windowStartMs > windowEndMs) {
    return res.status(400).json({ message: '事故区间倒置：开始时间不能晚于结束时间' });
  }

  const evidence = getEvidence();
  // 固定时刻用同一墙钟轴解析；历史数据均为合法时间，万一存在脏数据按无效输入拒绝
  const fixedAt = new Map<string, number | null>();
  for (const e of evidence) {
    if (e.occurredAt) {
      const t = parseWallTimeMs(e.occurredAt);
      if (t === null) return res.status(400).json({ message: `卡片「${e.title}」的已有发生时间格式无效，无法参与分析` });
      fixedAt.set(e.id, t);
    } else {
      fixedAt.set(e.id, null);
    }
  }

  const analysis = analyzeTimeWindow(
    evidence.map((e) => ({ id: e.id, createdAt: e.createdAt })),
    getEdges(),
    fixedAt,
    windowStartMs,
    windowEndMs,
    gapMinutes * MINUTE,
  );
  if (!analysis) {
    return res.status(409).json({ message: '当前约束图存在环，无法分析时间窗口' });
  }

  const result: TimeWindowResult = {
    feasible: analysis.feasible,
    windowStart: formatWallMinute(windowStartMs),
    windowEnd: formatWallMinute(windowEndMs),
    gapMinutes,
    cards: analysis.cards.map((c) => ({
      cardId: c.cardId,
      fixed: c.fixed,
      earliestMs: c.earliestMs,
      latestMs: c.latestMs,
      earliest: formatWallMinute(c.earliestMs),
      latest: formatWallMinute(c.latestMs),
    })),
    outOfRange: analysis.outOfRange.map((o) => ({
      cardId: o.cardId,
      fixedAtMs: o.fixedAtMs,
      fixedAt: formatWallMinute(o.fixedAtMs),
      side: o.side,
    })),
    conflict: analysis.conflict
      ? {
          kind: 'bound-conflict',
          pivotId: analysis.conflict.pivotId,
          lowerAtMs: analysis.conflict.lowerAtMs,
          upperAtMs: analysis.conflict.upperAtMs,
          lowerAt: formatWallMinute(analysis.conflict.lowerAtMs),
          upperAt: formatWallMinute(analysis.conflict.upperAtMs),
          path: analysis.conflict.path,
          lowerAnchor: analysis.conflict.lowerAnchor,
          upperAnchor: analysis.conflict.upperAnchor,
          lowerAnchorCardId: analysis.conflict.lowerAnchorCardId,
          upperAnchorCardId: analysis.conflict.upperAnchorCardId,
        }
      : null,
  };
  res.json(result);
});

/* ---------- 导入 / 导出 / 示例 ---------- */

app.get('/api/export', (_req, res) => {
  const snapshot = {
    app: 'evidence-chain-orchestrator',
    version: 1,
    exportedAt: new Date().toISOString(),
    evidence: getEvidence(),
    edges: getEdges().map((e) => ({ from: e.fromId, to: e.toId })),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="evidence-snapshot.json"');
  res.json(snapshot);
});

/** 确认导入时发现当前图或文件内容与预览时不一致：事务内抛出，整体回滚 */
class ImportStaleError extends Error {
  constructor() {
    super('import preview stale');
  }
}

/** 事务内复核发现快照含环（预览已拦截，作为防御性兜底） */
class SnapshotCycleError extends Error {
  cycle: string[];
  constructor(cycle: string[]) {
    super('snapshot cycle');
    this.cycle = cycle;
  }
}

/**
 * 差异预览（只读）：沿用导入校验解析快照，通过后按证据 id 比较四字段、
 * 按连线两端 id 比较，返回新增 / 删除 / 修改明细及数量。
 * 响应中的 token 把结果绑定到「当前图 + 文件内容指纹」，
 * 确认导入时在事务内重新核对两者，任一变化即拒绝覆盖。
 * 含环快照与正式导入一样拒绝（HTTP 422）。
 */
app.post('/api/import/preview', (req, res) => {
  const now = new Date().toISOString();
  let parsed;
  try {
    parsed = parseSnapshot(req.body, now);
  } catch (e) {
    if (e instanceof SnapshotValidationError) return res.status(400).json({ message: e.message });
    throw e;
  }
  if (!parsed.ok) return res.status(parsed.status).json({ message: parsed.message });

  const cycle = findCycle(parsed.value.items.map((i) => i.id), parsed.value.edges);
  if (cycle) {
    return res.status(422).json({ message: '快照中存在循环依赖，无法预览导入', cycle });
  }

  const view = currentGraphView(getEvidence(), getEdges());
  const diff = diffSnapshots(view, parsed.value);
  const token = signPreviewToken(fingerprintGraph(view), fingerprintSnapshot(parsed.value));
  const result: ImportPreview = { ...diff, token };
  res.json(result);
});

app.post('/api/import', (req, res) => {
  const body = (req.body ?? {}) as { token?: unknown };
  const token = verifyPreviewToken(body.token);
  if (!token.ok) {
    return res.status(400).json({ message: '请先进行导入差异预览，再确认导入' });
  }

  const now = new Date().toISOString();
  let parsed;
  try {
    parsed = parseSnapshot(req.body, now);
  } catch (e) {
    if (e instanceof SnapshotValidationError) return res.status(400).json({ message: e.message });
    throw e;
  }
  if (!parsed.ok) return res.status(parsed.status).json({ message: parsed.message });

  const { items, edges } = parsed.value;

  try {
    const tx = db.transaction(() => {
      // 事务内重新校验绑定的两份指纹：图在预览后被改动，或文件内容与预览时不一致，都拒绝覆盖
      const currentView = currentGraphView(getEvidence(), getEdges());
      if (fingerprintGraph(currentView) !== token.graphFingerprint) throw new ImportStaleError();
      if (fingerprintSnapshot(parsed.value) !== token.snapshotFingerprint) throw new ImportStaleError();

      // 环检测同样在事务内复核（含环快照仍拒绝），通过后才整体替换
      const cycle = findCycle(items.map((i) => i.id), edges);
      if (cycle) throw new SnapshotCycleError(cycle);

      db.prepare('DELETE FROM edges').run();
      db.prepare('DELETE FROM evidence').run();
      const insE = db.prepare(
        'INSERT INTO evidence (id, title, description, source, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const it of items) insE.run(it.id, it.title, it.description, it.source, it.occurredAt, it.createdAt, now);
      const insX = db.prepare('INSERT INTO edges (from_id, to_id, created_at) VALUES (?, ?, ?)');
      for (const e of edges) insX.run(e.fromId, e.toId, now);
    });
    tx();
  } catch (e) {
    if (e instanceof ImportStaleError) {
      return res.status(409).json({ stale: true, message: '当前图或快照文件在预览后已变化，请重新预览后再导入' });
    }
    if (e instanceof SnapshotCycleError) {
      return res.status(422).json({ message: '导入被拒绝：快照中存在循环依赖', cycle: e.cycle });
    }
    throw e;
  }
  res.json(buildState());
});

app.post('/api/seed', (_req, res) => {
  resetWithSample();
  res.json(buildState());
});

/* ---------- 静态资源与 SPA 回退 ---------- */

const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(200).send('客户端尚未构建：请先运行 npm run build，或使用 npm run dev 启动开发模式。');
  });
}

app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ message: '服务器内部错误' });
});

/* ---------- 启动 ---------- */

seedIfEmpty();

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  console.log(`[evidence-chain] 服务已启动: http://localhost:${PORT}`);
});
