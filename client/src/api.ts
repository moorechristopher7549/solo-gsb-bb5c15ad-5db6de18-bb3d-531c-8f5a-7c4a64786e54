import type { BypassPathResult, EvidenceFormValues, GraphState, ImportPreviewResult, MergeConflictKind, MustPassResult, OrderQueryResult, PruneResult, RedundantEdge, TimeWindowResult } from './types';

export class ApiError extends Error {
  status: number;
  payload: { message?: string; code?: string; cycle?: string[]; merge?: { kind: MergeConflictKind; path: string[] } };
  constructor(status: number, payload: { message?: string; code?: string; cycle?: string[]; merge?: { kind: MergeConflictKind; path: string[] } }) {
    super(payload.message ?? `请求失败（${status}）`);
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    code?: string;
    cycle?: string[];
    merge?: { kind: MergeConflictKind; path: string[] };
  };
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  state: () => request<GraphState>('/api/state'),
  createEvidence: (body: EvidenceFormValues) => request<GraphState>('/api/evidence', json('POST', body)),
  updateEvidence: (id: string, body: EvidenceFormValues) => request<GraphState>(`/api/evidence/${id}`, json('PUT', body)),
  deleteEvidence: (id: string) => request<GraphState>(`/api/evidence/${id}`, { method: 'DELETE' }),
  mergeEvidence: (sourceId: string, targetId: string) =>
    request<GraphState>('/api/evidence/merge', json('POST', { sourceId, targetId })),
  createEdge: (fromId: string, toId: string) => request<GraphState>('/api/edges', json('POST', { fromId, toId })),
  deleteEdge: (id: number) => request<GraphState>(`/api/edges/${id}`, { method: 'DELETE' }),
  redundancy: () => request<{ redundant: RedundantEdge[] }>('/api/redundancy'),
  pruneEdges: (edgeIds: number[]) => request<PruneResult>('/api/edges/prune', json('POST', { edgeIds })),
  orderQuery: (a: string, b: string) =>
    request<OrderQueryResult>(`/api/order-query?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  mustPass: (a: string, b: string) =>
    request<MustPassResult>(`/api/must-pass?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  mustPassBypass: (a: string, b: string, skip: string) =>
    request<BypassPathResult>(
      `/api/must-pass/bypass?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&skip=${encodeURIComponent(skip)}`,
    ),
  timeWindow: (start: string, end: string, gapMinutes: number) =>
    request<TimeWindowResult>(
      `/api/time-window?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&gap=${encodeURIComponent(String(gapMinutes))}`,
    ),
  /** 导入差异预览（只读）：服务端沿用导入校验，返回与当前图的逐项差异和一次性确认令牌 */
  importPreview: (snapshotText: string) =>
    request<ImportPreviewResult>('/api/import/preview', json('POST', { snapshotText })),
  /** 确认导入：服务端在事务内重新校验令牌、文件内容与当前图，全部一致才整体替换 */
  importConfirm: (token: string, snapshotText: string) =>
    request<GraphState>('/api/import/confirm', json('POST', { token, snapshotText })),
  seed: () => request<GraphState>('/api/seed', { method: 'POST' }),
};
