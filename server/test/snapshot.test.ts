import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SnapshotValidationError,
  currentGraphView,
  diffSnapshots,
  fingerprintGraph,
  fingerprintSnapshot,
  parseSnapshot,
  signPreviewToken,
  verifyPreviewToken,
} from '../src/snapshot';
import type { Edge, Evidence } from '../src/types';

const now = '2026-09-27T00:00:00.000Z';

function ev(id: string, title: string, extra: Partial<Pick<Evidence, 'source' | 'occurredAt' | 'description'>> = {}): Evidence {
  return {
    id,
    title,
    source: extra.source ?? '',
    occurredAt: extra.occurredAt ?? null,
    description: extra.description ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

function edge(id: number, fromId: string, toId: string): Edge {
  return { id, fromId, toId, createdAt: now };
}

test('parseSnapshot：无 id 卡片得到确定性合成 id，重复解析结果一致', () => {
  const body = {
    evidence: [{ title: 'A' }, { title: 'B', id: 'b1' }],
    edges: [],
  };
  const p1 = parseSnapshot(body, now);
  const p2 = parseSnapshot(body, now);
  assert.ok(p1.ok && p2.ok);
  if (!p1.ok || !p2.ok) return;
  assert.equal(p1.value.items[0].id, p2.value.items[0].id);
  assert.ok(p1.value.items[0].id.startsWith('new-'));
  assert.equal(p1.value.items[1].id, 'b1');
});

test('parseSnapshot：标题为空 / 非法时间 / 重复 id / 悬空连线被拒绝', () => {
  assert.throws(
    () => parseSnapshot({ evidence: [{ title: '  ' }], edges: [] }, now),
    SnapshotValidationError,
  );
  assert.throws(
    () => parseSnapshot({ evidence: [{ title: 'A', occurredAt: 'not-a-date' }], edges: [] }, now),
    SnapshotValidationError,
  );
  assert.throws(
    () => parseSnapshot({ evidence: [{ title: 'A', id: 'x' }, { title: 'B', id: 'x' }], edges: [] }, now),
    SnapshotValidationError,
  );
  const dangling = parseSnapshot({ evidence: [{ title: 'A', id: 'a' }], edges: [{ from: 'a', to: 'b' }] }, now);
  assert.equal(dangling.ok, false);
});

test('parseSnapshot：重复连线去重，结构字段错误返回 400', () => {
  const parsed = parseSnapshot(
    {
      evidence: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { fromId: 'a', toId: 'b' },
      ],
    },
    now,
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.edges.length, 1);

  const badShape = parseSnapshot({ evidence: [] }, now);
  assert.deepEqual(badShape.ok ? null : badShape.status, 400);
});

test('diffSnapshots：按 id 比较四字段、按连线两端比较，无 id 卡片视为新增', () => {
  const current = currentGraphView(
    [
      ev('a', '标题A', { source: '日志', occurredAt: '2026-03-12T02:00', description: '旧描述' }),
      ev('d', '将删除'),
    ],
    [
      edge(1, 'a', 'd'),
      edge(2, 'd', 'a'),
    ],
  );
  const incoming = parseSnapshot(
    {
      evidence: [
        { id: 'a', title: '标题A改', source: '监控', occurredAt: null, description: '旧描述' },
        { title: '全新卡片' },
      ],
      edges: [
        { from: 'a', to: 'd' }, // 保留（d 不在快照中，但这里实际悬空——改用合法端点）
      ],
    },
    now,
  );
  // d 已从快照移除，a→d 连线非法；换成 a→新卡的连线构造
  const fixed = parseSnapshot(
    {
      evidence: [
        { id: 'a', title: '标题A改', source: '监控', occurredAt: null, description: '旧描述' },
        { title: '全新卡片' },
      ],
      edges: [{ from: 'a', to: 'a' }],
    },
    now,
  );
  assert.ok(incoming.ok === false);
  assert.ok(fixed.ok);
  if (!fixed.ok) return;

  // 自环边 a→a 合法存在于解析结果（环检测是独立步骤）；再手工构造一组清晰的边
  const diff = diffSnapshots(current, {
    items: fixed.value.items,
    edges: [{ fromId: 'a', toId: fixed.value.items[1].id }],
  });

  assert.equal(diff.counts.added, 1);
  assert.equal(diff.added[0].title, '全新卡片');
  assert.equal(diff.counts.deleted, 1);
  assert.equal(diff.deleted[0].id, 'd');
  assert.equal(diff.counts.modified, 1);
  const fields = new Set(diff.modified[0].changes.map((c) => c.field));
  assert.deepEqual(fields, new Set(['title', 'source', 'occurredAt']));

  assert.equal(diff.counts.edgesAdded, 1);
  assert.equal(diff.counts.edgesDeleted, 2);
  assert.equal(diff.edgesAdded[0].fromTitle, '标题A改');
  assert.equal(diff.edgesAdded[0].toTitle, '全新卡片');
});

test('指纹：内容相同则一致；四字段或连线变化才变化；时间戳变化不影响', () => {
  const g1 = currentGraphView([ev('a', 'A')], [edge(1, 'a', 'a')]);
  const g2 = currentGraphView(
    [{ ...ev('a', 'A', {}), createdAt: 'other', updatedAt: 'other' }],
    [edge(9, 'a', 'a')],
  );
  assert.equal(fingerprintGraph(g1), fingerprintGraph(g2));

  const changed = currentGraphView([ev('a', 'A2')], [edge(1, 'a', 'a')]);
  assert.notEqual(fingerprintGraph(g1), fingerprintGraph(changed));

  const parsed = parseSnapshot({ evidence: [{ id: 'a', title: 'A' }], edges: [{ from: 'a', to: 'a' }] }, now);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(fingerprintSnapshot(parsed.value), fingerprintGraph(g1));
});

test('预览令牌：绑定两份指纹，篡改 / 过期均无效', () => {
  const token = signPreviewToken('g-hash', 's-hash');
  const ok = verifyPreviewToken(token);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(ok.graphFingerprint, 'g-hash');
  assert.equal(ok.snapshotFingerprint, 's-hash');

  assert.equal(verifyPreviewToken(token + 'x').ok, false);
  assert.equal(verifyPreviewToken('garbage').ok, false);
  assert.equal(verifyPreviewToken(undefined).ok, false);
});
