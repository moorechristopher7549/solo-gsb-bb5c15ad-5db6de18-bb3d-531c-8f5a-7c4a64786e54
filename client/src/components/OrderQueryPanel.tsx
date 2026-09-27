import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { GraphState, OrderQueryResult, OrderWitness } from '../types';

interface OrderQueryPanelProps {
  state: GraphState;
  /** 当前在画布上高亮的依据路径（再次点击可取消） */
  highlightPath: string[] | null;
  /** 当前正在预览的见证布局 */
  preview: OrderWitness | null;
  titleOf: (id: string) => string;
  onHighlightPath: (path: string[] | null) => void;
  onPreview: (w: OrderWitness | null) => void;
}

/** 顺序确定性查询面板：判定两张证据卡片的先后顺序是否已被现有约束确定 */
export default function OrderQueryPanel(props: OrderQueryPanelProps) {
  const { state, titleOf } = props;
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [result, setResult] = useState<OrderQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* 图状态变化后，上次判定结果即过期 */
  useEffect(() => {
    setResult(null);
    setErr(null);
  }, [state]);

  const canQuery = aId !== '' && bId !== '' && aId !== bId && !loading;

  const query = async () => {
    if (!canQuery) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.orderQuery(aId, bId);
      setResult(r);
      props.onHighlightPath(null);
      props.onPreview(null);
    } catch (e) {
      setResult(null);
      setErr(e instanceof ApiError ? e.message : '查询失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const toggleHighlight = () => {
    if (!result?.path) return;
    props.onHighlightPath(props.highlightPath ? null : result.path);
  };

  const witnessCard = (w: OrderWitness, label: string) => {
    const active = props.preview !== null && props.preview.firstId === w.firstId && props.preview.secondId === w.secondId;
    return (
      <div className={`witness-card${active ? ' active' : ''}`} key={label}>
        <h3>
          {label}：{titleOf(w.firstId)} 在 {titleOf(w.secondId)} 之前
        </h3>
        <div className="witness-order">{w.order.map((id, i) => `${i + 1}. ${titleOf(id)}`).join(' → ')}</div>
        <button type="button" className={`btn small${active ? ' active' : ''}`} onClick={() => props.onPreview(active ? null : w)}>
          {active ? '退出预览' : '预览此布局'}
        </button>
      </div>
    );
  };

  return (
    <section className="order-panel">
      <div className="order-head">
        <h2>顺序确定性查询</h2>
        <p className="muted">
          选择两张证据卡片，判定它们的先后顺序是否已被现有「必须早于」约束确定。未确定时会给出两个方向的合法拓扑序作为双向见证，可临时预览对应画布布局（不写入数据库）。
        </p>
      </div>
      <div className="order-controls">
        <select value={aId} onChange={(e) => setAId(e.target.value)} aria-label="证据 A">
          <option value="">选择证据 A…</option>
          {state.evidence.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.title}
            </option>
          ))}
        </select>
        <span className="muted">与</span>
        <select value={bId} onChange={(e) => setBId(e.target.value)} aria-label="证据 B">
          <option value="">选择证据 B…</option>
          {state.evidence.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.title}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" onClick={query} disabled={!canQuery}>
          {loading ? '判定中…' : '判定顺序'}
        </button>
        {aId !== '' && aId === bId && <span className="muted">请选择两张不同的卡片</span>}
      </div>
      {err && <div className="order-error">⚠ {err}</div>}
      {result && (
        <div className="order-result">
          <div className="order-verdict">
            {result.relation === 'a-before-b' && (
              <>
                判定：<b>{titleOf(result.aId)}</b> 必须早于 <b>{titleOf(result.bId)}</b>
              </>
            )}
            {result.relation === 'b-before-a' && (
              <>
                判定：<b>{titleOf(result.bId)}</b> 必须早于 <b>{titleOf(result.aId)}</b>
              </>
            )}
            {result.relation === 'unconstrained' && (
              <>
                判定：<b>{titleOf(result.aId)}</b> 与 <b>{titleOf(result.bId)}</b> 的先后顺序未被现有约束确定
              </>
            )}
          </div>
          {result.path && (
            <>
              <div className="order-path-line">最短约束路径：{result.path.map(titleOf).join(' → ')}</div>
              <div>
                <button
                  type="button"
                  className={`btn small${props.highlightPath ? ' active' : ''}`}
                  onClick={toggleHighlight}
                  title="在画布上以青色高亮该判定所依据的约束路径"
                >
                  {props.highlightPath ? '取消高亮' : '高亮依据路径'}
                </button>
              </div>
            </>
          )}
          {result.witnesses && (
            <div className="witness-row">
              {witnessCard(result.witnesses.aFirst, '见证 ①')}
              {witnessCard(result.witnesses.bFirst, '见证 ②')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
