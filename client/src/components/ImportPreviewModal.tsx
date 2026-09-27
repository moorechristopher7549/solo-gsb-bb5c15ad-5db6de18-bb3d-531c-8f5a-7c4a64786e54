import { useState, type ReactNode } from 'react';
import type { ImportCardView, ImportDiffField, ImportEdgeChange, ImportPreview } from '../types';

interface ImportPreviewModalProps {
  preview: ImportPreview;
  busy: boolean;
  /** 服务端拒绝：当前图或文件在预览后已变化，需要重新预览 */
  stale: boolean;
  onConfirm: () => void;
  onRepreview: () => void;
  onClose: () => void;
}

const FIELD_LABELS: Record<ImportDiffField, string> = {
  title: '标题',
  source: '来源',
  occurredAt: '发生时间',
  description: '描述',
};

const EMPTY = '（空）';

function showValue(v: string | null): string {
  return v && v.length > 0 ? v : EMPTY;
}

function CardDetail({ card }: { card: ImportCardView }) {
  return (
    <div className="imp-card">
      <div className="imp-card-title">{card.title}</div>
      <div className="imp-card-meta">
        <span>来源：{showValue(card.source)}</span>
        <span>发生时间：{showValue(card.occurredAt)}</span>
      </div>
      {card.description && <p className="imp-card-desc">{card.description}</p>}
    </div>
  );
}

function EdgeLine({ edge }: { edge: ImportEdgeChange }) {
  return (
    <li className="imp-edge">
      {edge.fromTitle} <b>必须早于</b> {edge.toTitle}
    </li>
  );
}

interface SectionProps {
  title: string;
  count: number;
  tone: 'add' | 'del' | 'mod' | 'edge-add' | 'edge-del';
  children: ReactNode;
}

function Section({ title, count, tone, children }: SectionProps) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section className={`imp-section imp-${tone}`}>
      <button type="button" className="imp-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="imp-section-title">
          <span className="imp-caret">{open ? '▾' : '▸'}</span>
          {title}
        </span>
        <span className="imp-count">{count}</span>
      </button>
      {open && <div className="imp-section-body">{children}</div>}
    </section>
  );
}

/** 导入差异预览弹窗：只读展示新增 / 删除 / 修改的卡片与新增 / 删除的连线，确认或取消 */
export default function ImportPreviewModal({ preview, busy, stale, onConfirm, onRepreview, onClose }: ImportPreviewModalProps) {
  const c = preview.counts;
  const noChange = c.added + c.deleted + c.modified + c.edgesAdded + c.edgesDeleted === 0;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal imp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h2>导入差异预览</h2>
        <p className="muted imp-file">
          文件：{preview.fileName ?? '快照文件'} · 预览为只读，确认后才会整体替换当前图
        </p>

        <div className="imp-stats">
          <span className="imp-chip add">新增卡片 {c.added}</span>
          <span className="imp-chip del">删除卡片 {c.deleted}</span>
          <span className="imp-chip mod">修改卡片 {c.modified}</span>
          <span className="imp-chip edge-add">新增连线 {c.edgesAdded}</span>
          <span className="imp-chip edge-del">删除连线 {c.edgesDeleted}</span>
        </div>

        {noChange && <p className="imp-no-change">快照与当前图完全一致，导入不会产生任何变化。</p>}

        <div className="imp-sections">
          <Section title="新增卡片" count={c.added} tone="add">
            {preview.added.map((card) => (
              <CardDetail key={card.id} card={card} />
            ))}
          </Section>

          <Section title="删除卡片" count={c.deleted} tone="del">
            {preview.deleted.map((card) => (
              <CardDetail key={card.id} card={card} />
            ))}
          </Section>

          <Section title="修改卡片（标题 / 来源 / 发生时间 / 描述）" count={c.modified} tone="mod">
            {preview.modified.map((m) => (
              <div key={m.id} className="imp-card">
                <div className="imp-card-title">{m.title}</div>
                <ul className="imp-fields">
                  {m.changes.map((ch) => (
                    <li key={ch.field}>
                      <span className="imp-field-name">{FIELD_LABELS[ch.field]}</span>
                      <span className="imp-before">{showValue(ch.before)}</span>
                      <span className="imp-arrow">→</span>
                      <span className="imp-after">{showValue(ch.after)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          <Section title="新增连线" count={c.edgesAdded} tone="edge-add">
            <ul className="imp-edges">
              {preview.edgesAdded.map((e) => (
                <EdgeLine key={`${e.fromId}->${e.toId}`} edge={e} />
              ))}
            </ul>
          </Section>

          <Section title="删除连线" count={c.edgesDeleted} tone="edge-del">
            <ul className="imp-edges">
              {preview.edgesDeleted.map((e) => (
                <EdgeLine key={`${e.fromId}->${e.toId}`} edge={e} />
              ))}
            </ul>
          </Section>
        </div>

        {stale && (
          <div className="toast error imp-stale" role="alert">
            当前图或快照文件在预览后已发生变化，为避免覆盖新内容，导入已被拒绝。请重新预览差异后再确认。
          </div>
        )}

        <div className="modal-actions imp-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          {stale ? (
            <button type="button" className="btn primary" onClick={onRepreview} disabled={busy}>
              重新预览
            </button>
          ) : (
            <button type="button" className="btn danger-solid" onClick={onConfirm} disabled={busy}>
              {busy ? '导入中…' : '确认导入（整体替换）'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
