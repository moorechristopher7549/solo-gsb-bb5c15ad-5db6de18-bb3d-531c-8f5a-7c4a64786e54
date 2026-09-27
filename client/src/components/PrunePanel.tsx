import type { RedundantEdge } from '../types';

interface PrunePanelProps {
  redundant: RedundantEdge[];
  /** 当前在画布上高亮的冗余连线（再次点击可取消） */
  focus: RedundantEdge | null;
  busy: boolean;
  titleOf: (id: string) => string;
  onFocus: (r: RedundantEdge | null) => void;
  onPruneAll: () => void;
}

/** 约束瘦身面板：逐条列出冗余连线及其最短替代路径，支持确认后批量移除 */
export default function PrunePanel({ redundant, focus, busy, titleOf, onFocus, onPruneAll }: PrunePanelProps) {
  if (redundant.length === 0) return null;
  return (
    <section className="prune-panel">
      <div className="prune-head">
        <div>
          <h2>约束瘦身</h2>
          <p className="muted">
            发现 {redundant.length} 条冗余连线：它们的先后关系已可由其他连线间接推出，移除后所有证据间的可达关系保持不变。点击任意一条可在画布上对照原连线和替代路径。
          </p>
        </div>
        <button className="btn danger-solid" onClick={onPruneAll} disabled={busy}>
          移除全部 {redundant.length} 条冗余连线
        </button>
      </div>
      <ul className="prune-list">
        {redundant.map((r) => {
          const active = focus?.edgeId === r.edgeId;
          return (
            <li key={r.edgeId}>
              <button
                type="button"
                className={`prune-item${active ? ' active' : ''}`}
                onClick={() => onFocus(active ? null : r)}
                title="点击在画布上高亮原连线（琥珀色）与替代路径（绿色）"
              >
                <span className="prune-edge">
                  {titleOf(r.fromId)} <b>必须早于</b> {titleOf(r.toId)}
                </span>
                <span className="prune-path">替代路径：{r.path.map(titleOf).join(' → ')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
