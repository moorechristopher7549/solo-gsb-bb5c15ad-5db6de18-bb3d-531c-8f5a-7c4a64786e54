import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { GraphState, TimeWindowHighlight, TimeWindowResult } from '../types';

interface TimeWindowPanelProps {
  state: GraphState;
  titleOf: (id: string) => string;
  /** 把冲突路径 / 越界卡片同步给画布高亮或定位 */
  onHighlight: (h: TimeWindowHighlight | null) => void;
}

const toLocalInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmt = (iso: string): string => iso.replace('T', ' ');

/** 时间窗口分析面板（只读）：在事故闭区间内沿 DAG 双向传播时间上下界 */
export default function TimeWindowPanel(props: TimeWindowPanelProps) {
  const { state, titleOf } = props;

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [gap, setGap] = useState('1');
  const [result, setResult] = useState<TimeWindowResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 高亮开关：冲突路径（红）；越界卡片定位后保持高亮 */
  const [hlOn, setHlOn] = useState(false);

  const onHighlightRef = useRef(props.onHighlight);
  onHighlightRef.current = props.onHighlight;

  /* 把当前冲突路径 / 越界卡片同步给画布；无结果或未开启高亮时清除 */
  useEffect(() => {
    if (!result || !hlOn) {
      onHighlightRef.current(null);
      return;
    }
    if (result.conflict) {
      onHighlightRef.current({
        path: result.conflict.path,
        pivotId: result.conflict.pivotId,
        outOfRange: [],
      });
    } else if (result.outOfRange.length > 0) {
      onHighlightRef.current({
        path: [],
        pivotId: null,
        outOfRange: result.outOfRange.map((o) => o.cardId),
      });
    } else {
      onHighlightRef.current(null);
    }
  }, [result, hlOn]);

  /* 图变化后旧结果即过期：清除结果与高亮（分析只读，不会被图变更自动续算） */
  useEffect(() => {
    setResult(null);
    setErr(null);
    setHlOn(false);
  }, [state]);

  /* Esc 退出高亮 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHlOn(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 客户端预校验：拒绝无效时间、倒置区间和非法间隔（服务端仍会复核） */
  const validate = (): string | null => {
    if (!start || !end) return '请填写事故起止时间';
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return '事故起止时间格式无效';
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (s > e) return '事故区间倒置：开始时间不能晚于结束时间';
    if (!/^\d+$/.test(gap.trim())) return '最小间隔必须为整数分钟';
    const g = Number(gap.trim());
    if (!Number.isSafeInteger(g) || g < 1) return '最小间隔必须为至少 1 分钟的整数';
    return null;
  };

  /** 输入变化后旧结果即过期：清除结果、错误与画布高亮 */
  const touchInputs = () => {
    setResult(null);
    setErr(null);
    setHlOn(false);
  };

  const analyze = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      setResult(null);
      setHlOn(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.timeWindow(start, end, Number(gap.trim()));
      setResult(r);
      // 无解（冲突 / 越界）时默认在画布高亮或定位，便于排查
      setHlOn(!r.feasible);
    } catch (e) {
      setResult(null);
      setHlOn(false);
      setErr(e instanceof ApiError ? e.message : '分析失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const anchorText = (anchor: 'window-start' | 'window-end' | 'fixed', cardId: string | null, at: string): string => {
    if (anchor === 'window-start') return `事故起点（${fmt(at || start)}）`;
    if (anchor === 'window-end') return `事故终点（${fmt(at || end)}）`;
    return `固定卡「${cardId ? titleOf(cardId) : '?'}」的发生时间`;
  };

  return (
    <section className="tw-panel">
      <div className="tw-head">
        <h2>时间窗口分析（只读）</h2>
        <p className="muted">
          输入事故起止时间（闭区间）与至少 1 分钟的整数最小间隔：所有卡片都须落在该区间内，已有发生时间作为固定时刻，
          每条「必须早于」连线要求后卡至少晚于前卡该间隔。服务端沿现有有向无环图双向传播时间上下界，
          列出每张卡片所有可行赋时中的最早、最晚时刻；空时间卡同样参与推导，孤立卡仅受事故区间限制。
          无解时不展示可行窗口，而是返回一条导致上下界冲突的真实约束路径并可在画布高亮；固定时刻越出区间时定位该卡片。分析不改写任何卡片或连线。
        </p>
      </div>
      <div className="order-controls tw-controls">
        <label className="tw-field">
          <span>事故开始</span>
          <input
            type="datetime-local"
            value={start}
            max={end || undefined}
            onChange={(e) => {
              setStart(e.target.value);
              touchInputs();
            }}
          />
        </label>
        <label className="tw-field">
          <span>事故结束</span>
          <input
            type="datetime-local"
            value={end}
            min={start || undefined}
            onChange={(e) => {
              setEnd(e.target.value);
              touchInputs();
            }}
          />
        </label>
        <label className="tw-field tw-gap">
          <span>最小间隔（分钟）</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={gap}
            onChange={(e) => {
              setGap(e.target.value);
              touchInputs();
            }}
          />
        </label>
        <button type="button" className="btn primary" onClick={analyze} disabled={loading}>
          {loading ? '分析中…' : '分析时间窗口'}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={start === '' && end === ''}
          title="填入今天 00:00–23:59 作为示例区间"
          onClick={() => {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            setStart(toLocalInput(d));
            d.setHours(23, 59, 0, 0);
            setEnd(toLocalInput(d));
            touchInputs();
          }}
        >
          今天全天
        </button>
      </div>
      {err && <div className="order-error">⚠ {err}</div>}

      {result && (
        <div className="tw-result">
          <div className="tw-summary">
            事故区间 <b>{fmt(result.windowStart)}</b> ～ <b>{fmt(result.windowEnd)}</b>，每条连线最小间隔{' '}
            <b>{result.gapMinutes}</b> 分钟
          </div>

          {result.feasible && (
            <>
              <div className="tw-verdict ok">✓ 存在可行赋时：下列窗口为每张卡片在所有可行赋时中的最早、最晚时刻</div>
              <div className="tw-table-wrap">
                <table className="tw-table">
                  <thead>
                    <tr>
                      <th>卡片</th>
                      <th>类型</th>
                      <th>最早时刻</th>
                      <th>最晚时刻</th>
                      <th>可浮动</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.cards.map((c) => {
                      const ev = state.evidence.find((e) => e.id === c.cardId);
                      const span = Math.round((c.latestMs - c.earliestMs) / 60000);
                      return (
                        <tr key={c.cardId} className={c.fixed ? 'tw-fixed' : ''}>
                          <td className="tw-card-name">{ev?.title ?? c.cardId.slice(0, 8)}</td>
                          <td>{c.fixed ? '固定时刻' : '空时间卡'}</td>
                          <td>{fmt(c.earliest)}</td>
                          <td>{fmt(c.latest)}</td>
                          <td>{c.fixed ? '—' : span === 0 ? '0 分钟' : `${span} 分钟`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!result.feasible && result.outOfRange.length > 0 && (
            <div className="tw-outrange">
              <div className="tw-verdict bad">✗ 固定时刻越出事故闭区间：下列卡片的已有发生时间不在区间内（闭区间），无法分析窗口</div>
              <ul className="tw-out-list">
                {result.outOfRange.map((o) => (
                  <li key={o.cardId}>
                    <b>{titleOf(o.cardId)}</b> 的发生时间 <b>{fmt(o.fixedAt)}</b>{' '}
                    {o.side === 'before-start' ? '早于事故开始' : '晚于事故结束'}
                    <button
                      type="button"
                      className={`btn small${hlOn ? ' active' : ''}`}
                      onClick={() => setHlOn(true)}
                      title="在画布上定位并高亮该卡片（红色脉动）"
                    >
                      在画布定位
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!result.feasible && result.conflict && (
            <div className="tw-conflict">
              <div className="tw-verdict bad">
                ✗ 不存在可行赋时：约束在卡片「{titleOf(result.conflict.pivotId)}」处推得的最早时刻{' '}
                <b>{fmt(result.conflict.lowerAt)}</b> 晚于允许的最晚时刻 <b>{fmt(result.conflict.upperAt)}</b>
              </div>
              <div className="tw-conflict-explain muted">
                下界来自{anchorText(result.conflict.lowerAnchor, result.conflict.lowerAnchorCardId, result.windowStart)}
                ，沿「必须早于」连线逐段加 {result.gapMinutes} 分钟传播；上界来自
                {anchorText(result.conflict.upperAnchor, result.conflict.upperAnchorCardId, result.windowEnd)}
                ，反向逐段减 {result.gapMinutes} 分钟传播。导致冲突的真实约束路径：
              </div>
              <div className="tw-path">{result.conflict.path.map(titleOf).join(' → ')}</div>
              <button
                type="button"
                className={`btn small${hlOn ? ' active' : ''}`}
                onClick={() => setHlOn(!hlOn)}
                title="在画布上以红色高亮该冲突路径，冲突卡片加脉动描边"
              >
                {hlOn ? '取消高亮冲突路径' : '在画布高亮冲突路径'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
