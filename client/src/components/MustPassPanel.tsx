import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { GraphState, MustPassHighlight, MustPassResult } from '../types';

interface MustPassPanelProps {
  state: GraphState;
  titleOf: (id: string) => string;
  /** 把当前高亮视图同步给画布（必经卡片 / 绕开核对路径） */
  onHighlight: (h: MustPassHighlight | null) => void;
}

/** 必经证据分析面板：找出所有 A→B 路径共同经过的中间卡片，并可核对绕开非必经卡片的真实路径 */
export default function MustPassPanel(props: MustPassPanelProps) {
  const { state, titleOf } = props;
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [result, setResult] = useState<MustPassResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 必经卡片高亮开关 */
  const [hlOn, setHlOn] = useState(false);
  /** 正在核对的绕开路径（被绕开的卡片 + 一条真实 A→B 路径） */
  const [bypass, setBypass] = useState<{ skipId: string; path: string[] } | null>(null);
  const [bypassBusy, setBypassBusy] = useState<string | null>(null);
  const [bypassErr, setBypassErr] = useState<string | null>(null);

  const onHighlightRef = useRef(props.onHighlight);
  onHighlightRef.current = props.onHighlight;
  const bypassRef = useRef(bypass);
  bypassRef.current = bypass;

  /* 把当前高亮视图同步给画布 */
  useEffect(() => {
    if (result && result.reachable && (hlOn || bypass)) {
      onHighlightRef.current({
        aId: result.aId,
        bId: result.bId,
        mustPass: hlOn ? result.mustPass : [],
        bypass,
      });
    } else {
      onHighlightRef.current(null);
    }
  }, [result, hlOn, bypass]);

  /* 卡片或连线变化后自动重新分析（只读刷新）；起终点被删除则清空结果 */
  useEffect(() => {
    if (!result) return;
    const ids = new Set(state.evidence.map((e) => e.id));
    if (!ids.has(result.aId) || !ids.has(result.bId)) {
      setResult(null);
      setBypass(null);
      setHlOn(false);
      setErr(null);
      setBypassErr(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await api.mustPass(result.aId, result.bId);
        if (!alive) return;
        setResult(r);
        // 刷新后必经集合为空（或已不可达）时收起必经高亮
        if (!r.reachable || r.mustPass.length === 0) setHlOn(false);
        // 正在核对的绕开路径也可能因图变化而失效：仍为可绕开卡片时重新取路，否则丢弃
        const cur = bypassRef.current;
        if (!cur) return;
        if (r.reachable && r.optional.includes(cur.skipId)) {
          try {
            const bp = await api.mustPassBypass(r.aId, r.bId, cur.skipId);
            if (alive) setBypass(bp.path ? { skipId: cur.skipId, path: bp.path } : null);
          } catch {
            if (alive) setBypass(null);
          }
        } else {
          setBypass(null);
        }
      } catch {
        if (alive) {
          setResult(null);
          setBypass(null);
          setHlOn(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // 仅在图状态变化时刷新；result 由本 effect 或手动分析更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  /* Esc 退出高亮与核对 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHlOn(false);
        setBypass(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const canQuery = aId !== '' && bId !== '' && aId !== bId && !loading;

  const clearResult = () => {
    setResult(null);
    setBypass(null);
    setHlOn(false);
    setErr(null);
    setBypassErr(null);
  };

  const query = async () => {
    if (!canQuery) return;
    setLoading(true);
    setErr(null);
    setBypassErr(null);
    setBypass(null);
    try {
      const r = await api.mustPass(aId, bId);
      setResult(r);
      // 有必经中间卡片时默认在画布高亮
      setHlOn(r.reachable && r.mustPass.length > 0);
    } catch (e) {
      setResult(null);
      setHlOn(false);
      setErr(e instanceof ApiError ? e.message : '分析失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  /** 点击可绕开卡片：核出一条绕开它的真实 A→B 路径（再次点击取消） */
  const toggleBypass = async (skipId: string) => {
    if (!result || bypassBusy !== null) return;
    if (bypass?.skipId === skipId) {
      setBypass(null);
      return;
    }
    setBypassBusy(skipId);
    setBypassErr(null);
    try {
      const r = await api.mustPassBypass(result.aId, result.bId, skipId);
      if (r.path) {
        setBypass({ skipId, path: r.path });
      } else {
        setBypass(null);
        setBypassErr(`当前图中已不存在绕开「${titleOf(skipId)}」的 A→B 路径（它可能已变成必经卡片）`);
      }
    } catch (e) {
      setBypassErr(e instanceof ApiError ? e.message : '核对失败，请重试');
    } finally {
      setBypassBusy(null);
    }
  };

  return (
    <section className="mustpass-panel">
      <div className="mustpass-head">
        <h2>必经证据分析</h2>
        <p className="muted">
          选定起点 A 与终点 B：仅当 A 能沿现有「必须早于」连线到达 B 时，列出所有 A→B 路径共同经过的中间卡片（必经证据），按约束先后展示并可在画布高亮；位于某条路径但并非必经的卡片，可点击核出一条绕开它的真实路径。分析只读，卡片或连线变化后结果自动刷新。
        </p>
      </div>
      <div className="order-controls">
        <select
          value={aId}
          onChange={(e) => {
            setAId(e.target.value);
            clearResult();
          }}
          aria-label="起点 A"
        >
          <option value="">选择起点 A…</option>
          {state.evidence.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.title}
            </option>
          ))}
        </select>
        <span className="muted">→</span>
        <select
          value={bId}
          onChange={(e) => {
            setBId(e.target.value);
            clearResult();
          }}
          aria-label="终点 B"
        >
          <option value="">选择终点 B…</option>
          {state.evidence.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.title}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" onClick={query} disabled={!canQuery}>
          {loading ? '分析中…' : '分析必经证据'}
        </button>
        {aId !== '' && aId === bId && <span className="muted">起点与终点需为不同卡片</span>}
      </div>
      {err && <div className="order-error">⚠ {err}</div>}
      {result && (
        <div className="mustpass-result">
          {!result.reachable && (
            <div className="mustpass-verdict">
              <b>{titleOf(result.aId)}</b> 无法沿现有「必须早于」连线到达 <b>{titleOf(result.bId)}</b>
              ：不存在 A→B 路径，必经证据分析不适用。
            </div>
          )}
          {result.reachable && (
            <>
              <div className="mustpass-verdict">
                从 <b>{titleOf(result.aId)}</b> 到 <b>{titleOf(result.bId)}</b>：
                {result.mustPass.length > 0
                  ? `所有路径共同经过 ${result.mustPass.length} 张中间卡片`
                  : result.direct
                    ? '存在直接连线，必经中间卡片为空'
                    : '必经中间卡片为空（每条路径都可绕开任一中间卡片）'}
              </div>
              {result.mustPass.length > 0 && (
                <div>
                  <div className="mustpass-subtitle">必经中间卡片（按约束先后）：</div>
                  <ol className="mustpass-list">
                    {result.mustPass.map((id) => (
                      <li key={id}>{titleOf(id)}</li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className={`btn small${hlOn ? ' active' : ''}`}
                    onClick={() => setHlOn(!hlOn)}
                    title="在画布上以粉色高亮起点、终点与全部必经中间卡片"
                  >
                    {hlOn ? '取消高亮' : '在画布高亮必经卡片'}
                  </button>
                </div>
              )}
              {result.optional.length > 0 && (
                <div>
                  <div className="mustpass-subtitle">可绕开的中间卡片（位于某条路径但非必经，点击核出绕开它的真实路径）：</div>
                  <div className="mustpass-chips">
                    {result.optional.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={`mustpass-chip${bypass?.skipId === id ? ' active' : ''}`}
                        disabled={bypassBusy !== null}
                        onClick={() => void toggleBypass(id)}
                      >
                        {bypassBusy === id ? '核对中…' : titleOf(id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {bypass && (
                <div className="mustpass-bypass">
                  <span>
                    绕开「{titleOf(bypass.skipId)}」的真实路径（画布橙色高亮）：{bypass.path.map(titleOf).join(' → ')}
                  </span>
                  <button type="button" className="btn small" onClick={() => setBypass(null)}>
                    清除核对
                  </button>
                </div>
              )}
              {bypassErr && <div className="order-error">⚠ {bypassErr}</div>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
