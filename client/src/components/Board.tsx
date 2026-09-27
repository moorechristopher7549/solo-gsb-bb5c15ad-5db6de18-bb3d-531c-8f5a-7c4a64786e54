import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Conflict } from '../App';
import type { Evidence, GraphState, MustPassHighlight, OrderWitness, RedundantEdge, TimeWindowHighlight } from '../types';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BoardProps {
  state: GraphState;
  conflict: Conflict | null;
  linkFrom: string | null;
  /** 合并重复证据模式：true=待选源卡片；字符串=已选源卡片 id、待选保留卡片；false=未启用 */
  mergeMode: boolean | string;
  /** 瘦身面板选中的冗余连线：高亮原连线与其替代路径 */
  pruneFocus: RedundantEdge | null;
  /** 顺序查询：高亮判定所依据的约束路径（节点 id 序列） */
  orderPath: string[] | null;
  /** 顺序查询：按见证拓扑临时预览画布布局（不写数据库） */
  preview: OrderWitness | null;
  /** 必经证据分析：高亮起终点与必经中间卡片，以及绕开核对路径 */
  mustPass: MustPassHighlight | null;
  /** 时间窗口分析：冲突路径 / 待定位的越界卡片（红色系） */
  timeWindow: TimeWindowHighlight | null;
  onStartLink: (id: string) => void;
  onCancelLink: () => void;
  onConnect: (fromId: string, toId: string) => void;
  onMergeSelect: (id: string) => void;
  onEdit: (ev: Evidence) => void;
  onDelete: (ev: Evidence) => void;
  onDeleteEdge: (id: number) => void;
}

const LEVEL_HINTS = ['无前置约束 · 最先发生', '需等待前一层完成', '需等待前两层完成'];

function curve(s: Rect, t: Rect): string {
  const x1 = s.x + s.w;
  const y1 = s.y + s.h / 2;
  const x2 = t.x;
  const y2 = t.y + t.h / 2;
  const dx = Math.max(36, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

function sameRects(a: Record<string, Rect>, b: Record<string, Rect>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const r1 = a[k];
    const r2 = b[k];
    if (!r2) return false;
    if (Math.abs(r1.x - r2.x) > 0.5 || Math.abs(r1.y - r2.y) > 0.5 || Math.abs(r1.w - r2.w) > 0.5 || Math.abs(r1.h - r2.h) > 0.5) {
      return false;
    }
  }
  return true;
}

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  return iso.replace('T', ' ').slice(0, 16);
}

export default function Board(props: BoardProps) {
  const { state, conflict, linkFrom } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, Rect>>({});
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ fromId: string; x: number; y: number; moved: boolean } | null>(null);

  const byId = useMemo(() => new Map(state.evidence.map((e) => [e.id, e])), [state.evidence]);

  /* 预览见证布局时改用见证层级分列、列内按见证拓扑序排列；否则按现有层级与发生时间 */
  const columns = useMemo(() => {
    const levels = props.preview?.levels ?? state.levels;
    const levelCount = props.preview?.levelCount ?? state.levelCount;
    const cols: Evidence[][] = Array.from({ length: Math.max(levelCount, 1) }, () => []);
    for (const ev of state.evidence) {
      const lv = levels[ev.id] ?? 0;
      (cols[lv] ?? cols[0]).push(ev);
    }
    if (props.preview) {
      const pos = new Map(props.preview.order.map((id, i) => [id, i]));
      for (const col of cols) {
        col.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
      }
    } else {
      for (const col of cols) {
        col.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') || a.title.localeCompare(b.title, 'zh'));
      }
    }
    return cols;
  }, [state, props.preview]);

  const conflictNodes = useMemo(() => new Set(conflict?.cycle ?? []), [conflict]);
  const conflictEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (conflict) {
      if (conflict.merge) {
        // 合并冲突：cycle 是当前图中导致冲突的真实路径（自环/成环），路径上的边全部标红
        for (let i = 0; i < conflict.cycle.length - 1; i++) {
          s.add(`${conflict.cycle[i]}->${conflict.cycle[i + 1]}`);
        }
      } else {
        // cycle = [尝试的起点, 尝试的终点, …, 起点]；跳过首对（那是被拒绝的新边），其余为图中已有边
        for (let i = 1; i < conflict.cycle.length - 1; i++) {
          s.add(`${conflict.cycle[i]}->${conflict.cycle[i + 1]}`);
        }
      }
    }
    return s;
  }, [conflict]);
  // 合并冲突路径由图中已有边构成，无需绘制「被否决的新边」虚线
  const attempted =
    conflict && !conflict.merge && conflict.cycle.length >= 2 ? { from: conflict.cycle[0], to: conflict.cycle[1] } : null;

  /* 瘦身高亮：原连线（琥珀色）+ 替代路径经过的边与节点（绿色） */
  const pruneAltEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (props.pruneFocus) {
      const p = props.pruneFocus.path;
      for (let i = 0; i < p.length - 1; i++) s.add(`${p[i]}->${p[i + 1]}`);
    }
    return s;
  }, [props.pruneFocus]);
  const prunePathNodes = useMemo(() => new Set(props.pruneFocus?.path ?? []), [props.pruneFocus]);
  const pruneTargetKey = props.pruneFocus ? `${props.pruneFocus.fromId}->${props.pruneFocus.toId}` : null;

  /* 顺序查询高亮：依据路径经过的边与节点（青色） */
  const orderPathEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (props.orderPath) {
      for (let i = 0; i < props.orderPath.length - 1; i++) s.add(`${props.orderPath[i]}->${props.orderPath[i + 1]}`);
    }
    return s;
  }, [props.orderPath]);
  const orderPathNodes = useMemo(() => new Set(props.orderPath ?? []), [props.orderPath]);

  /* 必经证据高亮：起终点与必经中间卡片（粉色）；绕开核对路径（橙色）与被绕开卡片 */
  const mustEndpoints = useMemo(
    () => (props.mustPass ? new Set([props.mustPass.aId, props.mustPass.bId]) : new Set<string>()),
    [props.mustPass],
  );
  const mustPassNodes = useMemo(() => new Set(props.mustPass?.mustPass ?? []), [props.mustPass]);
  const bypassPath = props.mustPass?.bypass?.path ?? null;
  const bypassNodes = useMemo(() => new Set(bypassPath ?? []), [bypassPath]);
  const bypassEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (bypassPath) {
      for (let i = 0; i < bypassPath.length - 1; i++) s.add(`${bypassPath[i]}->${bypassPath[i + 1]}`);
    }
    return s;
  }, [bypassPath]);
  const mustSkipId = props.mustPass?.bypass?.skipId ?? null;

  /* 时间窗口冲突高亮：冲突路径上的边与节点（红色），冲突卡片脉动；越界固定卡定位 */
  const twEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    const p = props.timeWindow?.path;
    if (p) {
      for (let i = 0; i < p.length - 1; i++) s.add(`${p[i]}->${p[i + 1]}`);
    }
    return s;
  }, [props.timeWindow]);
  const twPathNodes = useMemo(() => new Set(props.timeWindow?.path ?? []), [props.timeWindow]);
  const twPivotId = props.timeWindow?.pivotId ?? null;
  const twOutOfRange = useMemo(() => new Set(props.timeWindow?.outOfRange ?? []), [props.timeWindow]);

  /* 越界固定卡首次出现时滚动到可视区域（定位） */
  useEffect(() => {
    const ids = props.timeWindow?.outOfRange;
    if (!ids || ids.length === 0) return;
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(ids[0])}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    // 仅在定位目标变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.timeWindow]);

  /* 测量卡片位置，用于绘制 SVG 连线 */
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = () => {
      const bb = board.getBoundingClientRect();
      const next: Record<string, Rect> = {};
      board.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        next[el.dataset.cardId!] = {
          x: r.left - bb.left + board.scrollLeft,
          y: r.top - bb.top + board.scrollTop,
          w: r.width,
          h: r.height,
        };
      });
      setPositions((prev) => (sameRects(prev, next) ? prev : next));
      setSvgSize((prev) => {
        const w = board.scrollWidth;
        const h = board.scrollHeight;
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(board);
    board.querySelectorAll('[data-card-id]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [state, conflict, linkFrom, props.preview]);

  const toBoardPoint = (e: ReactPointerEvent) => {
    const board = boardRef.current!;
    const bb = board.getBoundingClientRect();
    return { x: e.clientX - bb.left + board.scrollLeft, y: e.clientY - bb.top + board.scrollTop };
  };

  const startLinkDrag = (e: ReactPointerEvent, id: string) => {
    if (props.mergeMode !== false) return;
    e.preventDefault();
    e.stopPropagation();
    boardRef.current?.setPointerCapture(e.pointerId);
    const p = toBoardPoint(e);
    setDrag({ fromId: id, x: p.x, y: p.y, moved: false });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = toBoardPoint(e);
    setDrag((d) => (d ? { ...d, x: p.x, y: p.y, moved: true } : d));
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag) return;
    const { fromId, moved } = drag;
    setDrag(null);
    if (moved) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-card-id]');
      const targetId = el?.getAttribute('data-card-id');
      if (targetId && targetId !== fromId) props.onConnect(fromId, targetId);
    } else {
      // 原地点击：进入/退出连线模式
      if (linkFrom === fromId) props.onCancelLink();
      else props.onStartLink(fromId);
    }
  };

  const onCardClick = (ev: Evidence) => {
    if (props.mergeMode !== false) {
      props.onMergeSelect(ev.id);
      return;
    }
    if (!linkFrom) return;
    if (linkFrom === ev.id) props.onCancelLink();
    else props.onConnect(linkFrom, ev.id);
  };

  const dragSource = drag ? positions[drag.fromId] : undefined;

  if (state.evidence.length === 0) {
    return (
      <section className="board-empty">
        <p>还没有证据卡片</p>
        <p className="muted">点击「新增证据」创建第一张卡片，或「载入示例」查看演示事故。</p>
      </section>
    );
  }

  return (
    <section className="board" ref={boardRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <svg className="edge-layer" width={svgSize.w} height={svgSize.h} aria-hidden>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#8b93ff" />
          </marker>
          <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#ff5c6c" />
          </marker>
          <marker id="arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#f0a840" />
          </marker>
          <marker id="arrow-green" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#4ade80" />
          </marker>
          <marker id="arrow-cyan" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#22d3ee" />
          </marker>
          <marker id="arrow-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#fb923c" />
          </marker>
          <marker id="arrow-red2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#ff5c6c" />
          </marker>
        </defs>

        {state.edges.map((e) => {
          const s = positions[e.fromId];
          const t = positions[e.toId];
          if (!s || !t) return null;
          const key = `${e.fromId}->${e.toId}`;
          const isConflict = conflictEdgeKeys.has(key);
          const isPruneTarget = key === pruneTargetKey;
          const isPruneAlt = pruneAltEdgeKeys.has(key);
          const isOrderPath = orderPathEdgeKeys.has(key);
          const isBypass = bypassEdgeKeys.has(key);
          const isTwConflict = twEdgeKeys.has(key);
          const cls = [
            'edge',
            isConflict ? 'conflict' : '',
            isPruneTarget ? 'prune-target' : '',
            isPruneAlt ? 'prune-alt' : '',
            isOrderPath ? 'order-path' : '',
            isBypass ? 'bypass' : '',
            isTwConflict ? 'tw-conflict' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const marker = isConflict
            ? 'arrow-red'
            : isPruneTarget
              ? 'arrow-amber'
              : isPruneAlt
                ? 'arrow-green'
                : isOrderPath
                  ? 'arrow-cyan'
                  : isBypass
                    ? 'arrow-orange'
                    : isTwConflict
                      ? 'arrow-red2'
                      : 'arrow';
          const d = curve(s, t);
          return (
            <g key={e.id} className={cls} onClick={() => props.onDeleteEdge(e.id)}>
              <title>{`${byId.get(e.fromId)?.title ?? ''} 必须早于 ${byId.get(e.toId)?.title ?? ''}（点击删除）`}</title>
              <path className="edge-hit" d={d} />
              <path className="edge-line" d={d} markerEnd={`url(#${marker})`} />
            </g>
          );
        })}

        {attempted && positions[attempted.from] && positions[attempted.to] && (
          <path className="edge-attempted" d={curve(positions[attempted.from], positions[attempted.to])} markerEnd="url(#arrow-red)" />
        )}

        {/* 见证预览：临时见证约束（青色虚线），仅前端展示，不写数据库 */}
        {props.preview && positions[props.preview.firstId] && positions[props.preview.secondId] && (
          <path
            className="edge-witness"
            d={curve(positions[props.preview.firstId], positions[props.preview.secondId])}
            markerEnd="url(#arrow-cyan)"
          />
        )}

        {drag && dragSource && (
          <line
            className="edge-dragging"
            x1={dragSource.x + dragSource.w}
            y1={dragSource.y + dragSource.h / 2}
            x2={drag.x}
            y2={drag.y}
          />
        )}
      </svg>

      <div className="columns">
        {columns.map((col, i) => (
          <div className="column" key={i}>
            <div className="column-header">
              <span className="column-title">
                层级 {i + 1}
                {props.preview ? ' · 预览' : ''}
              </span>
              <span className="column-hint">{LEVEL_HINTS[i] ?? `需等待前 ${i} 层完成`}</span>
            </div>
            {col.map((ev) => {
              const inConflict = conflictNodes.has(ev.id);
              const isSource = linkFrom === ev.id;
              const isTarget = linkFrom !== null && linkFrom !== ev.id;
              const isMergeSource = props.mergeMode === ev.id;
              const isMergePick = props.mergeMode !== false && !isMergeSource;
              const isPruneEndpoint =
                props.pruneFocus !== null && (props.pruneFocus.fromId === ev.id || props.pruneFocus.toId === ev.id);
              const isPrunePath = !isPruneEndpoint && prunePathNodes.has(ev.id);
              const isOrderPath = orderPathNodes.has(ev.id);
              const isMustEndpoint = mustEndpoints.has(ev.id);
              const isMustPass = mustPassNodes.has(ev.id);
              const isBypassNode = bypassNodes.has(ev.id);
              const isMustSkip = mustSkipId === ev.id;
              const isTwPath = twPathNodes.has(ev.id);
              const isTwPivot = twPivotId === ev.id;
              const isTwOutOfRange = twOutOfRange.has(ev.id);
              return (
                <article
                  key={ev.id}
                  data-card-id={ev.id}
                  className={[
                    'card',
                    inConflict ? 'in-conflict' : '',
                    isSource ? 'link-source' : '',
                    isTarget ? 'link-target' : '',
                    isMergeSource ? 'merge-source' : '',
                    isMergePick ? 'merge-pick' : '',
                    isPruneEndpoint ? 'prune-endpoint' : '',
                    isPrunePath ? 'prune-path' : '',
                    isOrderPath ? 'order-path' : '',
                    isMustEndpoint ? 'must-endpoint' : '',
                    isMustPass ? 'must-pass' : '',
                    isBypassNode ? 'bypass-node' : '',
                    isMustSkip ? 'must-skip' : '',
                    isTwPath ? 'tw-path' : '',
                    isTwPivot ? 'tw-pivot' : '',
                    isTwOutOfRange ? 'tw-outrange' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onCardClick(ev)}
                >
                  <h3 className="card-title">{ev.title}</h3>
                  <div className="card-meta">
                    {fmtTime(ev.occurredAt) && <span className="chip">🕒 {fmtTime(ev.occurredAt)}</span>}
                    {ev.source && <span className="chip">来源 · {ev.source}</span>}
                  </div>
                  {ev.description && <p className="card-desc">{ev.description}</p>}
                  <div className="card-actions">
                    <button
                      className="btn small"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onEdit(ev);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      className="btn small danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onDelete(ev);
                      }}
                    >
                      删除
                    </button>
                    <button
                      className={`btn small link${isSource ? ' active' : ''}`}
                      title="拖拽到另一张卡片，或点击后再点目标卡片"
                      onPointerDown={(e) => startLinkDrag(e, ev.id)}
                    >
                      ⇢ 连线
                    </button>
                  </div>
                  {isTarget && <div className="target-hint">点击：使「{byId.get(linkFrom!)?.title}」必须早于本卡</div>}
                  {isMergeSource && <div className="target-hint merge-hint-inline">源卡片（将删除）：点击其他卡片选作保留卡，或再次点击取消</div>}
                  {isMergePick && props.mergeMode === true && <div className="target-hint merge-hint-inline">点击：选为源卡片（合并后删除）</div>}
                  {isMergePick && props.mergeMode !== true && (
                    <div className="target-hint merge-hint-inline">点击：保留本卡，把「{byId.get(props.mergeMode as string)?.title}」合并进来</div>
                  )}
                </article>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
