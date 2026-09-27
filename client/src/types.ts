export interface Evidence {
  id: string;
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: number;
  fromId: string;
  toId: string;
  createdAt: string;
}

export interface GraphState {
  evidence: Evidence[];
  edges: Edge[];
  levels: Record<string, number>;
  levelCount: number;
}

/** 一条冗余连线及其最短替代路径（传递约简分析结果） */
export interface RedundantEdge {
  edgeId: number;
  fromId: string;
  toId: string;
  /** 忽略该连线后，从 fromId 到 toId 的一条最短替代路径（节点 id 序列，含起终点） */
  path: string[];
}

/** 批量瘦身结果：最新全量状态 + 实际移除 / 被跳过的连线 id */
export interface PruneResult extends GraphState {
  pruned: number[];
  skipped: number[];
}

/** 合并失败原因：改接后产生自环 / 有向环 */
export type MergeConflictKind = 'self-loop' | 'cycle';

/** 合并冲突详情：当前图中导致改接失败的真实路径（自环时为两端点） */
export interface MergeConflict {
  kind: MergeConflictKind;
  /** 冲突路径节点序列：自环时为有直接约束的两端点；成环时为导致闭环的一条真实路径 */
  path: string[];
  sourceId: string;
  targetId: string;
}

export interface EvidenceFormValues {
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

/** 顺序确定性查询的判定结论 */
export type OrderRelation = 'a-before-b' | 'b-before-a' | 'unconstrained';

/** 一个方向的见证布局：附加「firstId 必须早于 secondId」约束后的合法拓扑 */
export interface OrderWitness {
  firstId: string;
  secondId: string;
  /** 合法拓扑序（并列节点按创建时间、再按 id 稳定排序） */
  order: string[];
  /** 附加见证约束后的拓扑层级（仅用于临时预览画布布局） */
  levels: Record<string, number>;
  levelCount: number;
}

/** 顺序确定性查询结果 */
export interface OrderQueryResult {
  aId: string;
  bId: string;
  relation: OrderRelation;
  /** relation 为 a-before-b / b-before-a 时：从先到后的一条最短约束路径（含两端点） */
  path: string[] | null;
  /** relation 为 unconstrained 时：双向见证 */
  witnesses: { aFirst: OrderWitness; bFirst: OrderWitness } | null;
}

/** 必经证据分析结果（只读） */
export interface MustPassResult {
  aId: string;
  bId: string;
  /** A 是否能沿现有「必须早于」连线到达 B */
  reachable: boolean;
  /** 是否存在 A → B 直接连线（有则必经中间卡片必为空） */
  direct: boolean;
  /** 所有 A→B 路径共同经过的中间卡片（必经证据），按约束先后排序 */
  mustPass: string[];
  /** 位于某条 A→B 路径但并非必经的中间卡片（存在绕开它的真实路径），按约束先后排序 */
  optional: string[];
}

/** 绕开指定中间卡片的真实 A→B 路径核对结果 */
export interface BypassPathResult {
  aId: string;
  bId: string;
  skipId: string;
  /** 绕开 skipId 的一条最短 A→B 真实路径（含两端点）；不存在（该卡片实为必经）时为 null */
  path: string[] | null;
}

/** 必经证据分析在画布上的高亮视图 */
export interface MustPassHighlight {
  aId: string;
  bId: string;
  /** 高亮的必经中间卡片 */
  mustPass: string[];
  /** 正在核对的绕开路径（含两端点）与被绕开的卡片 */
  bypass: { skipId: string; path: string[] } | null;
}

/* ---------- 时间窗口分析（只读） ---------- */

/** 单张卡片在事故闭区间内的可行赋时窗口（最早 / 最晚时刻） */
export interface TimeWindowCard {
  cardId: string;
  /** 是否为已有发生时间的固定时刻卡片（固定时 earliest === latest） */
  fixed: boolean;
  earliestMs: number;
  latestMs: number;
  /** 分钟精度字符串（YYYY-MM-DDTHH:mm） */
  earliest: string;
  latest: string;
}

/** 固定时刻越出事故闭区间的卡片（定位用） */
export interface TimeWindowOutOfRange {
  cardId: string;
  fixedAtMs: number;
  fixedAt: string;
  side: 'before-start' | 'after-end';
}

/** 上下界冲突：一条真实约束路径在某张卡片上推得「最早时刻 > 最晚时刻」 */
export interface TimeWindowBoundConflict {
  kind: 'bound-conflict';
  pivotId: string;
  lowerAtMs: number;
  upperAtMs: number;
  lowerAt: string;
  upperAt: string;
  /** 导致冲突的真实约束路径（相邻节点即图中已有连线） */
  path: string[];
  lowerAnchor: 'window-start' | 'fixed';
  upperAnchor: 'window-end' | 'fixed';
  lowerAnchorCardId: string | null;
  upperAnchorCardId: string | null;
}

/** 时间窗口分析结果（只读） */
export interface TimeWindowResult {
  feasible: boolean;
  windowStart: string;
  windowEnd: string;
  gapMinutes: number;
  cards: TimeWindowCard[];
  outOfRange: TimeWindowOutOfRange[];
  conflict: TimeWindowBoundConflict | null;
}

/** 时间窗口分析在画布上的高亮视图 */
export interface TimeWindowHighlight {
  /** 上下界冲突路径（红色）或待定位的越界固定卡 */
  path: string[];
  /** 冲突卡片（上下界矛盾处） */
  pivotId: string | null;
  /** 需要定位的越界固定卡 id 列表 */
  outOfRange: string[];
}
