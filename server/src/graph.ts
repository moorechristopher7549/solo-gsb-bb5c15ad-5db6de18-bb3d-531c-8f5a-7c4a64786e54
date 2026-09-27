export interface EdgeLike {
  fromId: string;
  toId: string;
}

/**
 * 沿有向边方向，BFS 寻找 start → goal 的一条路径。
 * 返回包含两端点的节点 id 数组；不可达时返回 null。
 */
export function findPath(edges: EdgeLike[], start: string, goal: string): string[] | null {
  if (start === goal) return [start];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.fromId);
    if (list) list.push(e.toId);
    else adj.set(e.fromId, [e.toId]);
  }
  const prev = new Map<string, string | null>([[start, null]]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === goal) {
        const path = [goal];
        let p = prev.get(goal)!;
        while (p !== null) {
          path.unshift(p);
          p = prev.get(p)!;
        }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/**
 * 传递约简（约束瘦身）：找出所有冗余边。
 * 边 from → to 冗余 ⇔ 在忽略该边自身后，仍存在从 from 到 to 的路径
 * （即删除它不会改变任何节点间的可达关系）。
 * 每条冗余边附带一条最短替代路径（节点 id 序列，含起终点；BFS 保证边数最少）。
 * 按边的下标排除自身，即使图中存在重复边也不会误判。
 */
export interface RedundantEdgeInfo<T extends EdgeLike> {
  edge: T;
  /** 最短替代路径：从 edge.fromId 到 edge.toId 的节点 id 序列 */
  path: string[];
}

export function findRedundantEdges<T extends EdgeLike>(edges: T[]): Array<RedundantEdgeInfo<T>> {
  const out: Array<RedundantEdgeInfo<T>> = [];
  for (let i = 0; i < edges.length; i++) {
    const rest = edges.filter((_, j) => j !== i);
    const path = findPath(rest, edges[i].fromId, edges[i].toId);
    if (path) out.push({ edge: edges[i], path });
  }
  return out;
}

/**
 * 批量瘦身计划：按给定 id 顺序逐条检查——
 * 仅当该边在「当前剩余边集」中仍然冗余（忽略自身后仍有 from → to 路径）时才移除，
 * 否则跳过。冗余边可能相互依存（A→B 的替代路径恰好经过 A→C），
 * 逐条复核保证每次移除都不改变图的传递闭包，从而保持全部可达关系不变。
 */
export function planPrune<T extends EdgeLike & { id: number }>(
  edges: T[],
  ids: number[],
): { remove: T[]; skipped: number[] } {
  const remaining = [...edges];
  const remove: T[] = [];
  const skipped: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const idx = remaining.findIndex((e) => e.id === id);
    if (idx === -1) {
      skipped.push(id);
      continue;
    }
    const edge = remaining[idx];
    const rest = remaining.filter((_, j) => j !== idx);
    if (findPath(rest, edge.fromId, edge.toId)) {
      remove.push(edge);
      remaining.splice(idx, 1);
    } else {
      skipped.push(id);
    }
  }
  return { remove, skipped };
}

/* ---------- 重复证据合并 ---------- */

/** 合并失败原因：改接后产生自环 / 有向环 */
export type MergeConflictKind = 'self-loop' | 'cycle';

export interface MergeConflict {
  kind: MergeConflictKind;
  /**
   * 冲突路径（当前图中的真实节点序列，沿路径相邻节点即真实边）：
   * - self-loop：与那条将变成自环的直接约束同向的两端点序列（s→t 或 t→s）
   * - cycle：在当前图中导致改接成环的一条真实路径（首尾分别为 sourceId / targetId）
   */
  path: string[];
}

/**
 * 校验把源卡 sourceId 合并进保留卡 targetId（改接全部入边、出边）是否会产生自环或有向环。
 *
 * 在当前无环图上，改接后成环（含自环）当且仅当 sourceId 与 targetId 之间在当前图中存在直接约束，
 * 或沿已有边存在一条可达路径：
 * - 两者直接相连（s→t 或 t→s）：对端改接后该边变成 target→target 自环；
 * - sourceId 可达 targetId：sourceId 的出边改接到 target 后形成闭环；
 * - targetId 可达 sourceId：sourceId 的入边改接自 target 后形成闭环。
 * 直接约束优先判定为自环（即最直观的冲突路径），否则按可达方向返回冲突路径；无冲突返回 null。
 */
export function mergeConflict(edges: EdgeLike[], sourceId: string, targetId: string): MergeConflict | null {
  const directST = edges.some((e) => e.fromId === sourceId && e.toId === targetId);
  const directTS = edges.some((e) => e.fromId === targetId && e.toId === sourceId);
  if (directST) return { kind: 'self-loop', path: [sourceId, targetId] };
  if (directTS) return { kind: 'self-loop', path: [targetId, sourceId] };
  const sToT = findPath(edges, sourceId, targetId);
  if (sToT) return { kind: 'cycle', path: sToT };
  const tToS = findPath(edges, targetId, sourceId);
  if (tToS) return { kind: 'cycle', path: tToS };
  return null;
}

/**
 * 制定合并改接计划：源卡 sourceId 的全部入边、出边改接到 targetId，重复连线只留一条。
 * 调用前须先通过 mergeConflict 校验（计划假设改接不会产生自环/有向环）。
 *
 * 去重规则（与 edges 表 UNIQUE(from_id, to_id) 一致）：
 * - 与源卡相连的入边（x→sourceId）、出边（sourceId→x）改接到 targetId；
 * - 改接后与保留卡已有连线（x→targetId / targetId→x）重复的，删除源侧那一条；
 * - 与源卡无关节点间的连线原样保留。
 * 返回需要删除的边 id（重复边）与需要改接的边（id + 新端点）；其余边保持不变。
 */
export function planMergeEdges<T extends EdgeLike & { id: number }>(
  edges: T[],
  sourceId: string,
  targetId: string,
): { deleteIds: number[]; rewire: Array<{ id: number; fromId: string; toId: string }> } {
  const incoming = new Set(edges.filter((e) => e.toId === targetId).map((e) => e.fromId));
  const outgoing = new Set(edges.filter((e) => e.fromId === targetId).map((e) => e.toId));
  const deleteIds: number[] = [];
  const rewire: Array<{ id: number; fromId: string; toId: string }> = [];
  for (const e of edges) {
    if (e.toId === sourceId && e.fromId !== targetId) {
      if (incoming.has(e.fromId)) deleteIds.push(e.id);
      else rewire.push({ id: e.id, fromId: e.fromId, toId: targetId });
    } else if (e.fromId === sourceId && e.toId !== targetId) {
      if (outgoing.has(e.toId)) deleteIds.push(e.id);
      else rewire.push({ id: e.id, fromId: targetId, toId: e.toId });
    }
  }
  return { deleteIds, rewire };
}

/**
 * 校验「新增一条 fromId → toId 的边」是否会成环。
 * 若成环，返回完整闭环节点序列 [fromId, toId, …, fromId]
 * （首条为待保存的新边，其余为图中已有边）；否则返回 null。
 */
export function cycleAfterAdding(edges: EdgeLike[], newEdge: EdgeLike): string[] | null {
  if (newEdge.fromId === newEdge.toId) return [newEdge.fromId, newEdge.fromId];
  const back = findPath(edges, newEdge.toId, newEdge.fromId);
  if (!back) return null;
  return [newEdge.fromId, ...back];
}

/**
 * Kahn 拓扑排序 + 最长路径分层：level(n) = max(level(前置)) + 1。
 * 返回每个节点的层级（0 起）；若图中有环则返回 null。
 */
export function topoLevels(ids: string[], edges: EdgeLike[]): Record<string, number> | null {
  const indeg = new Map<string, number>();
  const level = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    level.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.fromId) || !indeg.has(e.toId)) continue;
    indeg.set(e.toId, indeg.get(e.toId)! + 1);
    adj.get(e.fromId)!.push(e.toId);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const nxt of adj.get(cur)!) {
      level.set(nxt, Math.max(level.get(nxt)!, level.get(cur)! + 1));
      indeg.set(nxt, indeg.get(nxt)! - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (visited !== ids.length) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of level) out[k] = v;
  return out;
}

/**
 * 确定性拓扑排序（Kahn）：就绪集中的并列节点统一按创建时间、再按 id 稳定排序，
 * 保证同一输入永远得到同一结果。可附加一条额外约束边（用于生成见证拓扑序）；
 * 图（含附加边）有环时返回 null。
 */
export interface OrderableNode {
  id: string;
  createdAt: string;
}

export function stableTopoOrder(nodes: OrderableNode[], edges: EdgeLike[], extraEdge: EdgeLike | null = null): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cmp = (x: string, y: string): number => {
    const a = byId.get(x)!;
    const b = byId.get(y)!;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  };
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  const all = extraEdge ? [...edges, extraEdge] : edges;
  for (const e of all) {
    if (!indeg.has(e.fromId) || !indeg.has(e.toId)) continue;
    indeg.set(e.toId, indeg.get(e.toId)! + 1);
    adj.get(e.fromId)!.push(e.toId);
  }
  // 就绪集始终按 (createdAt, id) 升序，保证结果确定
  const ready = nodes
    .filter((n) => indeg.get(n.id) === 0)
    .map((n) => n.id)
    .sort(cmp);
  const order: string[] = [];
  while (ready.length > 0) {
    const cur = ready.shift()!;
    order.push(cur);
    for (const nxt of adj.get(cur)!) {
      const d = indeg.get(nxt)! - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        let pos = ready.length;
        while (pos > 0 && cmp(ready[pos - 1], nxt) > 0) pos--;
        ready.splice(pos, 0, nxt);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/**
 * 顺序确定性查询：判定两张卡片的先后顺序是否已被约束确定。
 * - A 可达 B：A 必须早于 B，返回 A → B 的一条最短约束路径；
 * - B 可达 A：B 必须早于 A，返回 B → A 的一条最短约束路径；
 * - 互相不可达：顺序未被约束，分别附加见证方向边（A→B 与 B→A），
 *   生成两个合法拓扑序作为双向见证。
 * aId === bId 或图（含见证边）有环时返回 null。
 */
export type OrderRelation = 'a-before-b' | 'b-before-a' | 'unconstrained';

export interface OrderQueryOutcome {
  relation: OrderRelation;
  /** relation 为 a-before-b / b-before-a 时：从先到后的一条最短约束路径（含两端点） */
  path: string[] | null;
  /** relation 为 unconstrained 时：双向见证拓扑序（aFirst 中 a 在 b 前，bFirst 反之） */
  witnesses: { aFirst: string[]; bFirst: string[] } | null;
}

export function queryOrder(nodes: OrderableNode[], edges: EdgeLike[], aId: string, bId: string): OrderQueryOutcome | null {
  if (aId === bId) return null;
  const pathAB = findPath(edges, aId, bId);
  if (pathAB) return { relation: 'a-before-b', path: pathAB, witnesses: null };
  const pathBA = findPath(edges, bId, aId);
  if (pathBA) return { relation: 'b-before-a', path: pathBA, witnesses: null };
  const aFirst = stableTopoOrder(nodes, edges, { fromId: aId, toId: bId });
  const bFirst = stableTopoOrder(nodes, edges, { fromId: bId, toId: aId });
  if (!aFirst || !bFirst) return null;
  return { relation: 'unconstrained', path: null, witnesses: { aFirst, bFirst } };
}

/* ---------- 必经证据分析 ---------- */

/** 从 start 出发沿有向边可达的全部节点集合（含 start 自身） */
function reachableSet(edges: EdgeLike[], start: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.fromId);
    if (list) list.push(e.toId);
    else adj.set(e.fromId, [e.toId]);
  }
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      queue.push(nxt);
    }
  }
  return seen;
}

export interface MustPassAnalysis {
  /** A 是否能沿现有「必须早于」连线到达 B */
  reachable: boolean;
  /** 是否存在 A → B 的直接连线（有则必经中间卡片必为空） */
  direct: boolean;
  /** 所有 A→B 路径共同经过的中间卡片（必经证据），按约束先后排序 */
  mustPass: string[];
  /** 位于某条 A→B 路径但并非必经的中间卡片（存在绕开它的真实路径），按约束先后排序 */
  optional: string[];
}

/**
 * 必经证据分析：在 A 可达 B 的前提下，找出所有 A→B 路径共同经过的中间卡片。
 *
 * 中间卡片 v 「必经」⇔ 在删除 v（及其相连连线）后的图中 A 不再可达 B；
 * 否则 v 位于某条 A→B 路径上但可被绕开（optional）。
 * 候选集 = 从 A 可达 且 能到达 B 的节点（即位于某条 A→B 路径上的节点），剔除 A、B 自身。
 * 结果按确定性拓扑序（约束先后）排序；A 不可达 B 时 reachable=false；
 * aId === bId 或图有环时返回 null。
 */
export function analyzeMustPass(
  nodes: OrderableNode[],
  edges: EdgeLike[],
  aId: string,
  bId: string,
): MustPassAnalysis | null {
  if (aId === bId) return null;
  if (!findPath(edges, aId, bId)) {
    return { reachable: false, direct: false, mustPass: [], optional: [] };
  }
  const order = stableTopoOrder(nodes, edges);
  if (!order) return null;
  // 正向：A 可达的节点；反向：能到达 B 的节点（在反向图上从 B 出发）
  const forward = reachableSet(edges, aId);
  const reversed = edges.map((e) => ({ fromId: e.toId, toId: e.fromId }));
  const backward = reachableSet(reversed, bId);
  const direct = edges.some((e) => e.fromId === aId && e.toId === bId);
  const mustPass: string[] = [];
  const optional: string[] = [];
  for (const id of forward) {
    if (id === aId || id === bId || !backward.has(id)) continue;
    const rest = edges.filter((e) => e.fromId !== id && e.toId !== id);
    if (findPath(rest, aId, bId)) optional.push(id);
    else mustPass.push(id);
  }
  const pos = new Map(order.map((id, i) => [id, i]));
  const byOrder = (x: string, y: string): number => (pos.get(x) ?? 0) - (pos.get(y) ?? 0);
  mustPass.sort(byOrder);
  optional.sort(byOrder);
  return { reachable: true, direct, mustPass, optional };
}

/**
 * 绕开指定中间卡片的真实路径：在删除 skipId（及其相连连线）后的图中，
 * 寻找 A→B 的一条最短路径（含两端点）。
 * 找不到（该卡片实为必经，或 A 根本不可达 B）以及 skipId 为起点/终点时返回 null。
 */
export function findBypassPath(edges: EdgeLike[], aId: string, bId: string, skipId: string): string[] | null {
  if (skipId === aId || skipId === bId) return null;
  const rest = edges.filter((e) => e.fromId !== skipId && e.toId !== skipId);
  return findPath(rest, aId, bId);
}

/**
 * 在已有图中寻找一个环（用于导入快照校验）。
 * 返回闭环节点序列 [n, …, n]；无环返回 null。
 */
export function findCycle(ids: string[], edges: EdgeLike[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (adj.has(e.fromId) && adj.has(e.toId)) adj.get(e.fromId)!.push(e.toId);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const parent = new Map<string, string | null>();

  for (const root of ids) {
    if (color.get(root) !== WHITE) continue;
    color.set(root, GRAY);
    parent.set(root, null);
    const stack: Array<[string, Iterator<string>]> = [[root, (adj.get(root) ?? [])[Symbol.iterator]()]];
    while (stack.length > 0) {
      const [node, it] = stack[stack.length - 1];
      const next = it.next();
      if (next.done) {
        color.set(node, BLACK);
        stack.pop();
        continue;
      }
      const n = next.value as string;
      if (color.get(n) === GRAY) {
        // 发现回边 node → n：沿父链回溯出完整闭环 n → … → node → n
        const cycle = [n];
        let cur: string = node;
        while (cur !== n) {
          cycle.unshift(cur);
          cur = parent.get(cur)!;
        }
        cycle.unshift(n);
        return cycle;
      }
      if (color.get(n) === WHITE) {
        color.set(n, GRAY);
        parent.set(n, node);
        stack.push([n, (adj.get(n) ?? [])[Symbol.iterator]()]);
      }
    }
  }
  return null;
}

/* ---------- 时间窗口分析（沿 DAG 双向传播时间上下界） ---------- */

export interface TimeWindowNode {
  id: string;
  /** 已有发生时间（固定时刻）；null 表示空时间卡，赋时待定 */
  fixedAtMs: number | null;
}

export interface TimeWindowConflict {
  pivotId: string;
  lowerAtMs: number;
  upperAtMs: number;
  path: string[];
  lowerAnchor: 'window-start' | 'fixed';
  upperAnchor: 'window-end' | 'fixed';
  lowerAnchorCardId: string | null;
  upperAnchorCardId: string | null;
}

export interface TimeWindowAnalysis {
  feasible: boolean;
  /** 确定性拓扑序（按创建时间、再按 id 稳定排序），结果按此顺序输出 */
  order: string[];
  cards: Array<{ cardId: string; fixed: boolean; earliestMs: number; latestMs: number }>;
  outOfRange: Array<{ cardId: string; fixedAtMs: number; side: 'before-start' | 'after-end' }>;
  conflict: TimeWindowConflict | null;
}

interface LowerWitness {
  anchor: 'window-start' | 'fixed';
  anchorCardId: string | null;
  /** 下界传播链：锚点（起点）→ … → 当前卡片，相邻节点为真实边 */
  chain: string[];
}

interface UpperWitness {
  anchor: 'window-end' | 'fixed';
  anchorCardId: string | null;
  /** 上界传播链：当前卡片 → … → 锚点（终点），相邻节点为真实边 */
  chain: string[];
}

/**
 * 时间窗口分析（纯只读）：
 *
 * 在事故闭区间 [windowStartMs, windowEndMs] 内，沿现有「必须早于」DAG
 * 对每条边施加约束 `t(to) >= t(from) + gapMs`（后卡至少晚于前卡 gapMs），
 * 固定时刻卡片取定值。先正向（拓扑序）传播下界（最早时刻）、
 * 再反向传播上界（最晚时刻）；当某张卡片的下界 > 上界时无解，
 * 取首个冲突卡片，用其上下界见证链拼出一条导致冲突的真实约束路径。
 *
 * 空时间卡参与推导；孤立卡仅受事故闭区间限制（最早=区间起点、最晚=区间终点）。
 * 固定时刻越出闭区间的卡片优先报出（定位该卡），存在越界卡时不做上下界传播。
 * 图有环时返回 null（现有图本就保证无环）。
 */
export function analyzeTimeWindow(
  nodes: OrderableNode[],
  edges: EdgeLike[],
  fixedAt: Map<string, number | null>,
  windowStartMs: number,
  windowEndMs: number,
  gapMs: number,
): TimeWindowAnalysis | null {
  const order = stableTopoOrder(nodes, edges);
  if (!order) return null;

  const adj = new Map<string, string[]>();
  const radj = new Map<string, string[]>();
  for (const id of order) {
    adj.set(id, []);
    radj.set(id, []);
  }
  for (const e of edges) {
    if (!adj.has(e.fromId) || !adj.has(e.toId)) continue;
    adj.get(e.fromId)!.push(e.toId);
    radj.get(e.toId)!.push(e.fromId);
  }
  // 邻接按 id 排序，保证多前驱取同一最大值时结果确定
  for (const list of adj.values()) list.sort();
  for (const list of radj.values()) list.sort();

  const fixedOf = (id: string): number | null => fixedAt.get(id) ?? null;

  /* 固定时刻越出事故闭区间优先报出：存在时定位该卡片，不再传播上下界 */
  const outOfRange: TimeWindowAnalysis['outOfRange'] = [];
  for (const id of order) {
    const f = fixedOf(id);
    if (f === null) continue;
    if (f < windowStartMs) outOfRange.push({ cardId: id, fixedAtMs: f, side: 'before-start' });
    else if (f > windowEndMs) outOfRange.push({ cardId: id, fixedAtMs: f, side: 'after-end' });
  }
  if (outOfRange.length > 0) {
    return { feasible: false, order, cards: [], outOfRange, conflict: null };
  }

  /* 正向传播下界：lb(v) = max(区间起点, 固定值, 前驱 lb + gap) */
  const lb = new Map<string, number>();
  const lw = new Map<string, LowerWitness>();
  for (const id of order) {
    let value = windowStartMs;
    let witness: LowerWitness = { anchor: 'window-start', anchorCardId: null, chain: [id] };
    const f = fixedOf(id);
    if (f !== null) {
      value = f;
      witness = { anchor: 'fixed', anchorCardId: id, chain: [id] };
    }
    for (const p of radj.get(id)!) {
      const candidate = lb.get(p)! + gapMs;
      if (candidate > value) {
        value = candidate;
        const pw = lw.get(p)!;
        witness = { anchor: pw.anchor, anchorCardId: pw.anchorCardId, chain: [...pw.chain, id] };
      }
    }
    lb.set(id, value);
    lw.set(id, witness);
  }

  /* 反向传播上界：ub(v) = min(区间终点, 固定值, 后继 ub - gap) */
  const ub = new Map<string, number>();
  const uw = new Map<string, UpperWitness>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let value = windowEndMs;
    let witness: UpperWitness = { anchor: 'window-end', anchorCardId: null, chain: [id] };
    const f = fixedOf(id);
    if (f !== null) {
      value = f;
      witness = { anchor: 'fixed', anchorCardId: id, chain: [id] };
    }
    for (const s of adj.get(id)!) {
      const candidate = ub.get(s)! - gapMs;
      if (candidate < value) {
        value = candidate;
        const sw = uw.get(s)!;
        witness = { anchor: sw.anchor, anchorCardId: sw.anchorCardId, chain: [id, ...sw.chain] };
      }
    }
    ub.set(id, value);
    uw.set(id, witness);
  }

  /* 首个下界 > 上界的卡片即冲突点；其两条见证链拼成一条真实约束路径 */
  for (const id of order) {
    if (lb.get(id)! <= ub.get(id)!) continue;
    const lower = lw.get(id)!;
    const upper = uw.get(id)!;
    // 下界链：锚点 → … → id；上界链：id → … → 锚点（去掉重复的 id 后拼接）
    const path = [...lower.chain, ...upper.chain.slice(1)];
    return {
      feasible: false,
      order,
      cards: [],
      outOfRange: [],
      conflict: {
        pivotId: id,
        lowerAtMs: lb.get(id)!,
        upperAtMs: ub.get(id)!,
        path,
        lowerAnchor: lower.anchor,
        upperAnchor: upper.anchor,
        lowerAnchorCardId: lower.anchorCardId,
        upperAnchorCardId: upper.anchorCardId,
      },
    };
  }

  const cards = order.map((id) => {
    const f = fixedOf(id);
    return { cardId: id, fixed: f !== null, earliestMs: lb.get(id)!, latestMs: ub.get(id)! };
  });
  return { feasible: true, order, cards, outOfRange: [], conflict: null };
}
