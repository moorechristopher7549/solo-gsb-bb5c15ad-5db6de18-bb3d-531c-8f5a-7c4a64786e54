import { useEffect, useState } from 'react';
import type { Evidence, EvidenceFormValues } from '../types';

interface CardFormProps {
  initial: Evidence | null;
  busy: boolean;
  onSubmit: (values: EvidenceFormValues) => void;
  onClose: () => void;
}

export default function CardForm({ initial, busy, onSubmit, onClose }: CardFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [occurredAt, setOccurredAt] = useState(initial?.occurredAt ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  useEffect(() => {
    const first = document.querySelector<HTMLInputElement>('.modal input');
    first?.focus();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h2>{initial ? '编辑证据' : '新增证据'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ title: title.trim(), source: source.trim(), occurredAt: occurredAt || null, description: description.trim() });
          }}
        >
          <label>
            标题 *
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="例如：数据库连接池耗尽" />
          </label>
          <label>
            来源
            <input value={source} onChange={(e) => setSource(e.target.value)} maxLength={200} placeholder="例如：Grafana 监控 / 应用日志" />
          </label>
          <label>
            发生时间（可选，仅作展示；时间线顺序由连线约束决定）
            <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </label>
          <label>
            描述
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={4} placeholder="补充证据细节、链接、影响范围…" />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
