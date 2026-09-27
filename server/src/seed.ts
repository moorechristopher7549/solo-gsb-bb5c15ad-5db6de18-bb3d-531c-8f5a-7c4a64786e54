import crypto from 'node:crypto';
import { db } from './db';

interface SampleCard {
  title: string;
  source: string;
  occurredAt: string;
  description: string;
}

/** 示例事故：2026-03 支付网关宕机 */
const SAMPLE: SampleCard[] = [
  { title: '发布支付服务 v2.3.1', source: 'CI/CD 流水线', occurredAt: '2026-03-12T02:15', description: '变更内容：数据库连接池 maxIdle 由 50 调整为 5。' },
  { title: '数据库慢查询开始攀升', source: 'Grafana 监控', occurredAt: '2026-03-12T02:20', description: 'p99 查询耗时从 40ms 升至 1.8s。' },
  { title: '数据库连接池耗尽', source: '应用日志', occurredAt: '2026-03-12T02:33', description: '日志大量出现 connection acquire timeout。' },
  { title: '触发 P1 告警', source: '告警平台', occurredAt: '2026-03-12T02:41', description: '支付成功率跌破 95% 阈值，电话值班。' },
  { title: '执行版本回滚', source: '值班运维', occurredAt: '2026-03-12T02:47', description: '回滚至 v2.3.0，恢复连接池配置。' },
  { title: '客服工单激增', source: '客服系统', occurredAt: '2026-03-12T02:50', description: '用户集中反馈支付失败，工单量 10 分钟上涨 8 倍。' },
  { title: '服务恢复正常', source: 'Grafana 监控', occurredAt: '2026-03-12T02:55', description: '支付成功率回升至 99.9%，事故进入复盘阶段。' },
];

/** [fromIndex, toIndex]：from 必须早于 to */
const SAMPLE_EDGES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 6],
  [3, 5],
];

export function resetWithSample(): void {
  const now = new Date().toISOString();
  const ids = SAMPLE.map(() => crypto.randomUUID());
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM edges').run();
    db.prepare('DELETE FROM evidence').run();
    const insE = db.prepare(
      'INSERT INTO evidence (id, title, description, source, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    SAMPLE.forEach((s, i) => insE.run(ids[i], s.title, s.description, s.source, s.occurredAt, now, now));
    const insX = db.prepare('INSERT INTO edges (from_id, to_id, created_at) VALUES (?, ?, ?)');
    for (const [a, b] of SAMPLE_EDGES) insX.run(ids[a], ids[b], now);
  });
  tx();
}

export function seedIfEmpty(): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM evidence').get() as { c: number };
  if (row.c === 0) resetWithSample();
}
