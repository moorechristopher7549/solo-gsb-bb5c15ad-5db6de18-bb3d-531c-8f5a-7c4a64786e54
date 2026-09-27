import { useState } from 'react';
import type { ImportDiff, ImportFieldName } from '../types';

interface ImportPreviewDialogProps {
  fileName: string;
  diff: ImportDiff;
  busy: boolean;
  /** 预览已失效：当前图或文件在预览后发生变化，确认按钮禁用，需重新预览 */
  staleMessage: string | null;
  onConfirm: () => void;
  onRepreview: () => void;
  onCancel: () => void;
}

const FIELD_LABELS: Record<ImportFieldName, string> = {
  title: '标题',
  source: '来源',
  occurredAt: '发生时间',
  description: '描述',
};

const EMPTY_TEXT = '（空）';

function FieldValue({ value, kind }: { value: string; kind: 'before' | 'after' }) {
  const text = value === '' ? EMPTY_TEXT : value;
  return (
    <span className={kind === 'before' ? 'ip-old' : 'ip-new'} title={text}>
      {text}
    </span>
  );
}

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: 'add' | 'remove' | 'modify';
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`ip-section ip-${tone}`}>
      <button type="button" className="ip-section-head" onClick={() => setOpen((v) => !v)} disabled={count === 0}>
        <span className="ip-caret">{count > 0 ? (open ? '▾' : '▸') : '·'}</span>
        <span className="ip-section-title">{title}</span>
        <span className="ip-count">{count}</span>
      </button>
      {open && count > 0 && <div className="ip-section-body">{children}</div>}
    </section>
  );
}

export default function ImportPreviewDialog({
  fileName,
  diff,
  busy,
  staleMessage,
  onConfirm,
  onRepreview,
  onCancel,
}: ImportPreviewDialogProps) {
  const c = diff.counts;
  const total = c.addedCards + c.removedCards + c.modifiedCards + c.addedEdges + c.removedEdges;
  const noChange = total === 0;

  return (
    <div className="modal-backdrop" onClick={staleMessage ? undefined : onCancel}>
      <div className="modal import-preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h2>导入差异预览</h2>
        <p className="ip-file">
          文件：<b title={fileName}>{fileName}</b>
        </p>
        <p className="ip-hint">预览为只读，不会修改当前数据。确认导入后将整体替换当前证据链。</p>

        <div className="ip-summary">
          <span className="ip-tag add">新增卡片 {c.addedCards}</span>
          <span className="ip-tag modify">修改卡片 {c.modifiedCards}</span>
          <span className="ip-tag remove">删除卡片 {c.removedCards}</span>
          <span className="ip-tag add">新增连线 {c.addedEdges}</span>
          <span className="ip-tag remove">删除连线 {c.removedEdges}</span>
        </div>

        {noChange && <p className="ip-nochange">文件内容与当前证据链完全一致，导入不会产生任何变化。</p>}

        <div className="ip-sections">
          <Section title="新增卡片" count={c.addedCards} tone="add">
            <ul className="ip-list">
              {diff.addedCards.map((card) => (
                <li key={card.id}>
                  <span className="ip-card-title">{card.title}</span>
                  <span className="ip-card-id" title={card.id}>
                    {card.id.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="删除卡片" count={c.removedCards} tone="remove">
            <ul className="ip-list">
              {diff.removedCards.map((card) => (
                <li key={card.id}>
                  <span className="ip-card-title">{card.title}</span>
                  <span className="ip-card-id" title={card.id}>
                    {card.id.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="修改卡片（标题 / 来源 / 发生时间 / 描述）" count={c.modifiedCards} tone="modify">
            <ul className="ip-list ip-modify-list">
              {diff.modifiedCards.map((card) => (
                <li key={card.id}>
                  <div className="ip-card-title" title={card.id}>
                    {card.title}
                  </div>
                  <dl className="ip-fields">
                    {card.changes.map((ch) => (
                      <div className="ip-field" key={ch.field}>
                        <dt>{FIELD_LABELS[ch.field]}</dt>
                        <dd>
                          <FieldValue value={ch.before} kind="before" />
                          <span className="ip-arrow">→</span>
                          <FieldValue value={ch.after} kind="after" />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="新增连线" count={c.addedEdges} tone="add">
            <ul className="ip-list">
              {diff.addedEdges.map((e) => (
                <li key={`${e.fromId}->${e.toId}`}>
                  <span className="ip-edge">
                    {e.fromTitle} <b>必须早于</b> {e.toTitle}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="删除连线" count={c.removedEdges} tone="remove">
            <ul className="ip-list">
              {diff.removedEdges.map((e) => (
                <li key={`${e.fromId}->${e.toId}`}>
                  <span className="ip-edge">
                    {e.fromTitle} <b>必须早于</b> {e.toTitle}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        {staleMessage && (
          <p className="toast error ip-stale" role="alert">
            <span>⚠ {staleMessage}</span>
          </p>
        )}

        <div className="modal-actions">
          {staleMessage ? (
            <>
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={onRepreview} disabled={busy}>
                重新预览
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn danger-solid" onClick={onConfirm} disabled={busy}>
                {busy ? '导入中…' : `确认导入并整体替换${noChange ? '' : `（${total} 项变化）`}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
