import { useMemo } from 'react';
import type { Evidence, GraphState } from '../types';

interface TimelinePanelProps {
  state: GraphState;
}

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  return iso.replace('T', ' ').slice(0, 16);
}

/** 可解释时间线：按拓扑层级解释每张卡片为何排在该位置 */
export default function TimelinePanel({ state }: TimelinePanelProps) {
  const byId = useMemo(() => new Map(state.evidence.map((e) => [e.id, e])), [state.evidence]);

  const predecessors = useMemo(() => {
    const m = new Map<string, Evidence[]>();
    for (const e of state.edges) {
      const from = byId.get(e.fromId);
      if (!from) continue;
      const list = m.get(e.toId) ?? [];
      list.push(from);
      m.set(e.toId, list);
    }
    return m;
  }, [state.edges, byId]);

  const levels = useMemo(() => {
    const ls: Evidence[][] = Array.from({ length: state.levelCount }, () => []);
    for (const ev of state.evidence) {
      const lv = state.levels[ev.id] ?? 0;
      (ls[lv] ?? (ls[lv] = [])).push(ev);
    }
    return ls;
  }, [state]);

  return (
    <aside className="panel">
      <h2>时间线解读</h2>
      <div className="stats">
        <span className="ok">✓ 无环</span>
        <span>{state.levelCount} 个层级</span>
        <span>{state.edges.length} 条约束</span>
        <span>{state.evidence.length} 张卡片</span>
      </div>

      {levels.map((cards, i) => (
        <div className="level-block" key={i}>
          <h3>
            层级 {i + 1}
            <small>{i === 0 ? ' · 无前置约束，最先发生' : ` · 需等待前 ${i} 层完成`}</small>
          </h3>
          <ul>
            {cards.map((ev) => {
              const preds = predecessors.get(ev.id) ?? [];
              return (
                <li key={ev.id}>
                  <span className="ev-title">{ev.title}</span>
                  {fmtTime(ev.occurredAt) && <span className="muted">（{fmtTime(ev.occurredAt)}）</span>}
                  {preds.length > 0 && <div className="why">需等待：{preds.map((p) => p.title).join('、')}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {state.edges.length > 0 && (
        <div className="level-block">
          <h3>约束清单</h3>
          <ul>
            {state.edges.map((e) => (
              <li key={e.id} className="constraint">
                {byId.get(e.fromId)?.title ?? '?'} <b>必须早于</b> {byId.get(e.toId)?.title ?? '?'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
