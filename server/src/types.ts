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
  /** 前置证据：必须更早发生 */
  fromId: string;
  /** 后续证据：必须更晚发生 */
  toId: string;
  createdAt: string;
}

export interface GraphState {
  evidence: Evidence[];
  edges: Edge[];
  /** 每张卡片所在的拓扑层级（0 起），由「必须早于」约束推导 */
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

export interface RedundancyReport {
  redundant: RedundantEdge[];
}

/** 批量瘦身结果：最新全量状态 + 实际移除 / 被跳过的连线 id */
export interface PruneResult extends GraphState {
  pruned: number[];
  skipped: number[];
}

/** 合并失败原因：改接后产生自环 / 有向环 */
export type MergeConflictKind = 'self-loop' | 'cycle';

/** 合并冲突：当前图中导致改接失败的一条真实路径（自环时为两端点） */
export interface MergeConflict {
  kind: MergeConflictKind;
  path: string[];
}

/** 顺序确定性查询的判定结论 */
export type OrderRelation = 'a-before-b' | 'b-before-a' | 'unconstrained';

/** 一个方向的见证布局：附加「firstId 必须早于 secondId」约束后的合法拓扑 */
export interface OrderWitness {
  firstId: string;
  secondId: string;
  /** 合法拓扑序（并列节点按创建时间、再按 id 稳定排序） */
  order: string[];
  /** 附加见证约束后的拓扑层级（供前端临时预览画布布局，不写数据库） */
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

/* ---------- 时间窗口分析（只读） ---------- */

/** 单张卡片在事故闭区间内的可行赋时窗口（最早 / 最晚时刻） */
export interface TimeWindowCard {
  cardId: string;
  /** 是否为已有发生时间的固定时刻卡片（固定时 earliest === latest） */
  fixed: boolean;
  earliestMs: number;
  latestMs: number;
  /** 墙钟分钟精度字符串（YYYY-MM-DDTHH:mm），与录入/展示口径一致、不受时区影响 */
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
  /** 上下界发生冲突的卡片 */
  pivotId: string;
  lowerAtMs: number;
  upperAtMs: number;
  /** 冲突时间：下界要求的最早时刻 / 上界允许的最晚时刻（分钟精度字符串） */
  lowerAt: string;
  upperAt: string;
  /**
   * 导致冲突的真实约束路径（卡片 id 序列，相邻卡片即图中已有连线）：
   * 前半段沿「必须早于」连线把下界从下界锚点传播到 pivot，
   * 后半段沿反向连线把上界从上界锚点传播回 pivot。
   */
  path: string[];
  lowerAnchor: 'window-start' | 'fixed';
  upperAnchor: 'window-end' | 'fixed';
  /** 锚点为固定时刻时对应的固定卡片 id（锚点可能就是 pivot 自身） */
  lowerAnchorCardId: string | null;
  upperAnchorCardId: string | null;
}

/** 时间窗口分析结果（只读，不改写卡片或连线） */
export interface TimeWindowResult {
  feasible: boolean;
  windowStart: string;
  windowEnd: string;
  gapMinutes: number;
  /** feasible=true 时：每张卡片的最早 / 最晚可行时刻（按确定性拓扑序排列） */
  cards: TimeWindowCard[];
  /** 固定时刻越出事故闭区间的卡片（存在时不做传播、不展示可行窗口） */
  outOfRange: TimeWindowOutOfRange[];
  /** feasible=false 且无越界固定卡时：导致上下界冲突的真实约束路径 */
  conflict: TimeWindowBoundConflict | null;
}

/* ---------- 导入差异预览（只读） ---------- */

/** 预览中的卡片四要素视图 */
export interface ImportCardView {
  id: string;
  title: string;
  source: string;
  occurredAt: string | null;
  description: string;
}

/** 参与比较的卡片字段 */
export type ImportDiffField = 'title' | 'source' | 'occurredAt' | 'description';

export interface ImportFieldChange {
  field: ImportDiffField;
  before: string;
  after: string;
}

/** 同 id 卡片中发生修改的一张及其逐字段变化 */
export interface ImportModifiedCard {
  id: string;
  title: string;
  changes: ImportFieldChange[];
}

/** 连线差异（按两端 id 比较，标题仅用于前端展示） */
export interface ImportEdgeChange {
  fromId: string;
  toId: string;
  fromTitle: string;
  toTitle: string;
}

/** 导入差异预览结果：绑定当前图与文件内容的只读对照 */
export interface ImportPreview {
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
  /** 确认导入时回传的绑定令牌（绑定当前图指纹与快照指纹，HMAC 签名、30 分钟有效） */
  token: string;
}
