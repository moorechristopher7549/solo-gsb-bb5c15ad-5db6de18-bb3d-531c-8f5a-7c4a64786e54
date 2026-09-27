import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import Board from './components/Board';
import CardForm from './components/CardForm';
import ConflictBanner from './components/ConflictBanner';
import MustPassPanel from './components/MustPassPanel';
import OrderQueryPanel from './components/OrderQueryPanel';
import PrunePanel from './components/PrunePanel';
import TimeWindowPanel from './components/TimeWindowPanel';
import TimelinePanel from './components/TimelinePanel';
import type { Evidence, EvidenceFormValues, GraphState, MergeConflict, MustPassHighlight, OrderWitness, RedundantEdge, TimeWindowHighlight } from './types';

export interface Conflict {
  cycle: string[];
  message: string;
  /** 由「合并重复证据」触发时附带的冲突详情（自环 / 有向环） */
  merge?: MergeConflict;
}

export default function App() {
  const [state, setState] = useState<GraphState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  /** 重复证据合并：true=待选源卡片；字符串=已选源卡片 id、待选保留卡片；false=未启用 */
  const [mergeMode, setMergeMode] = useState<boolean | string>(false);
  const [editing, setEditing] = useState<Evidence | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [redundant, setRedundant] = useState<RedundantEdge[]>([]);
  const [pruneFocus, setPruneFocus] = useState<RedundantEdge | null>(null);
  /** 顺序查询：画布上高亮的依据路径 / 正在预览的见证布局 */
  const [orderPath, setOrderPath] = useState<string[] | null>(null);
  const [orderPreview, setOrderPreview] = useState<OrderWitness | null>(null);
  /** 必经证据分析：画布上的高亮视图（由 MustPassPanel 全权维护） */
  const [mustPassHL, setMustPassHL] = useState<MustPassHighlight | null>(null);
  /** 时间窗口分析：画布上的冲突路径 / 越界定位（由 TimeWindowPanel 全权维护） */
  const [timeWindowHL, setTimeWindowHL] = useState<TimeWindowHighlight | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .state()
      .then(setState)
      .catch(() => setError('无法连接服务器，请确认后端已启动'));
  }, []);

  /* 图状态每次变化后重新做传递约简分析，并取消可能已失效的瘦身高亮与顺序查询高亮/预览 */
  useEffect(() => {
    if (!state) return;
    setPruneFocus(null);
    setOrderPath(null);
    setOrderPreview(null);
    let alive = true;
    api
      .redundancy()
      .then((r) => {
        if (alive) setRedundant(r.redundant);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkFrom(null);
        setMergeMode(false);
        setEditing(null);
        setOrderPath(null);
        setOrderPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleApiError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.payload.cycle) {
      setConflict({ cycle: e.payload.cycle, message: e.payload.message ?? e.message });
      setError(null);
    } else {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }, []);

  /** 执行一次会改变图状态的操作；成功后清除冲突高亮与连线模式 */
  const run = useCallback(
    async (fn: () => Promise<GraphState>) => {
      setBusy(true);
      try {
        setState(await fn());
        setConflict(null);
        setLinkFrom(null);
        setError(null);
      } catch (e) {
        handleApiError(e);
      } finally {
        setBusy(false);
      }
    },
    [handleApiError],
  );

  const connect = useCallback((fromId: string, toId: string) => run(() => api.createEdge(fromId, toId)), [run]);

  const submitCard = useCallback(
    async (values: EvidenceFormValues) => {
      if (editing === null) return;
      setBusy(true);
      try {
        setState(editing === 'new' ? await api.createEvidence(values) : await api.updateEvidence(editing.id, values));
        setEditing(null);
        setConflict(null);
        setError(null);
      } catch (e) {
        handleApiError(e);
      } finally {
        setBusy(false);
      }
    },
    [editing, handleApiError],
  );

  const deleteCard = useCallback(
    (ev: Evidence) => {
      if (!window.confirm(`删除证据「${ev.title}」？相关连线将一并删除。`)) return;
      void run(() => api.deleteEvidence(ev.id));
    },
    [run],
  );

  const deleteEdge = useCallback(
    (id: number) => {
      if (!window.confirm('删除这条「必须早于」连线？')) return;
      void run(() => api.deleteEdge(id));
    },
    [run],
  );

  /** 确认后把源卡合并进保留卡：保留卡标题/来源/时间/描述不变，连线由服务端事务改接 */
  const mergeCards = useCallback(
    async (sourceId: string, targetId: string) => {
      const source = state?.evidence.find((e) => e.id === sourceId);
      const target = state?.evidence.find((e) => e.id === targetId);
      if (!source || !target) {
        setMergeMode(false);
        return;
      }
      if (
        !window.confirm(
          `将重复证据「${source.title}」合并进「${target.title}」？\n\n` +
            `· 源卡「${source.title}」将被删除\n` +
            `· 它的全部「必须早于」连线会改接到保留卡，重复连线只保留一条\n` +
            `· 保留卡的标题、来源、发生时间和描述保持不变\n\n` +
            `若改接会产生自环或循环依赖，将整体拒绝并高亮冲突路径。`,
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        setState(await api.mergeEvidence(sourceId, targetId));
        setConflict(null);
        setLinkFrom(null);
        setError(null);
      } catch (e) {
        if (e instanceof ApiError && e.payload.merge) {
          setConflict({
            cycle: e.payload.merge.path,
            message: e.payload.message ?? e.message,
            merge: { kind: e.payload.merge.kind, path: e.payload.merge.path, sourceId, targetId },
          });
          setError(null);
        } else {
          handleApiError(e);
        }
      } finally {
        setBusy(false);
        setMergeMode(false);
      }
    },
    [state, handleApiError],
  );

  /** 合并模式下选择卡片：第一张为源卡片，第二张为保留卡片；再次点击源卡片退出 */
  const onMergeSelect = useCallback(
    (id: string) => {
      if (mergeMode === false || mergeMode === true) {
        setMergeMode(id);
      } else if (mergeMode === id) {
        setMergeMode(false);
      } else {
        void mergeCards(mergeMode, id);
      }
    },
    [mergeMode, mergeCards],
  );

  const onImportFile = useCallback(
    async (file: File) => {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        setError('导入失败：文件不是合法 JSON');
        return;
      }
      if (!window.confirm('导入将覆盖当前全部证据与连线，确定继续？')) return;
      await run(() => api.importSnapshot(payload));
    },
    [run],
  );

  const loadSample = useCallback(() => {
    if (!window.confirm('载入示例将覆盖当前全部数据，确定继续？')) return;
    void run(() => api.seed());
  }, [run]);

  /* 确认后批量移除：服务端在单个事务中复核并删除当前仍冗余的连线 */
  const pruneAll = useCallback(() => {
    if (redundant.length === 0) return;
    if (
      !window.confirm(
        `将移除 ${redundant.length} 条冗余连线。移除后所有证据间的先后可达关系保持不变，确定继续？`,
      )
    ) {
      return;
    }
    void run(() => api.pruneEdges(redundant.map((r) => r.edgeId)));
  }, [redundant, run]);

  const titleOf = useCallback(
    (id: string) => state?.evidence.find((e) => e.id === id)?.title ?? id.slice(0, 8),
    [state],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⛓</span>
          <div>
            <h1>事故证据链编排器</h1>
            <p>用「必须早于」约束编排证据，自动推演可解释时间线</p>
          </div>
        </div>
        <div className="toolbar">
          <button className="btn primary" onClick={() => setEditing('new')} disabled={busy}>
            ＋ 新增证据
          </button>
          <button
            className={`btn${mergeMode !== false ? ' active' : ''}`}
            onClick={() => {
              setMergeMode((m) => (m === false ? true : false));
              setLinkFrom(null);
            }}
            disabled={busy}
            title="先点选源卡片（被合并、将删除），再点选保留卡片"
          >
            ⛓ 合并重复证据
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            导入 JSON
          </button>
          <a className="btn" href="/api/export" download="evidence-snapshot.json">
            导出 JSON
          </a>
          <button className="btn" onClick={loadSample} disabled={busy}>
            载入示例
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {error && (
        <div className="toast error" role="alert">
          <span>⚠ {error}</span>
          <button className="toast-close" onClick={() => setError(null)} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {conflict && <ConflictBanner conflict={conflict} titleOf={titleOf} onClose={() => setConflict(null)} />}

      {state && (
        <PrunePanel
          redundant={redundant}
          focus={pruneFocus}
          busy={busy}
          titleOf={titleOf}
          onFocus={setPruneFocus}
          onPruneAll={pruneAll}
        />
      )}

      {state && (
        <OrderQueryPanel
          state={state}
          highlightPath={orderPath}
          preview={orderPreview}
          titleOf={titleOf}
          onHighlightPath={setOrderPath}
          onPreview={setOrderPreview}
        />
      )}

      {state && <MustPassPanel state={state} titleOf={titleOf} onHighlight={setMustPassHL} />}

      {state && <TimeWindowPanel state={state} titleOf={titleOf} onHighlight={setTimeWindowHL} />}

      {orderPreview && (
        <div className="preview-banner">
          <span>
            正在预览见证布局：假设「{titleOf(orderPreview.firstId)}」<b>必须早于</b>「{titleOf(orderPreview.secondId)}」
            （青色虚线为临时见证约束，仅前端预览，不会写入数据库，Esc 退出）
          </span>
          <button className="btn small" onClick={() => setOrderPreview(null)}>
            退出预览
          </button>
        </div>
      )}

      {linkFrom && state && (
        <div className="link-hint">
          连线模式：点击另一张卡片，使「{titleOf(linkFrom)}」<b>必须早于</b>它（Esc 取消）
        </div>
      )}

      {mergeMode !== false && (
        <div className="link-hint merge-hint">
          {mergeMode === true ? (
            <>合并模式：先点击作为<b>源卡片</b>的重复证据（合并后将被删除），再点击保留卡片（Esc 取消）</>
          ) : (
            <>
              合并模式：已选源卡片「{titleOf(mergeMode)}」，现在点击要<b>保留</b>的卡片；再次点击源卡片或按 Esc 取消
            </>
          )}
        </div>
      )}

      <main className="main">
        {state ? (
          <>
            <Board
              state={state}
              conflict={conflict}
              linkFrom={linkFrom}
              mergeMode={mergeMode}
              pruneFocus={pruneFocus}
              orderPath={orderPath}
              preview={orderPreview}
              mustPass={mustPassHL}
              timeWindow={timeWindowHL}
              onStartLink={setLinkFrom}
              onCancelLink={() => setLinkFrom(null)}
              onConnect={connect}
              onMergeSelect={onMergeSelect}
              onEdit={setEditing}
              onDelete={deleteCard}
              onDeleteEdge={deleteEdge}
            />
            <TimelinePanel state={state} />
          </>
        ) : (
          <div className="loading">加载中…</div>
        )}
      </main>

      {editing !== null && (
        <CardForm
          initial={editing === 'new' ? null : editing}
          busy={busy}
          onSubmit={submitCard}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
