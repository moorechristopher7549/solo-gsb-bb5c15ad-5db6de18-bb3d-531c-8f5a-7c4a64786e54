import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPreviewToken,
  computeImportDiff,
  createPreviewToken,
  deletePreviewToken,
  graphFingerprint,
  parseSnapshot,
  snapshotHash,
} from '../src/importing';

const NOW = '2026-09-27T00:00:00.000Z';

interface SimpleCard {
  id: string;
  title: string;
  description: string;
  source: string;
  occurredAt: string | null;
}

const card = (id: string, overrides: Partial<SimpleCard> = {}): SimpleCard => ({
  id,
  title: id,
  description: '',
  source: '',
  occurredAt: null,
  ...overrides,
});

test('computeImportDiff：按 id 列出新增 / 删除 / 修改卡片，无 id 卡片视为新增', () => {
  const current = {
    evidence: [
      card('a', { title: '卡片A' }),
      card('b', { title: '卡片B', source: '日志' }),
      card('c', { title: '卡片C' }),
    ],
    edges: [{ fromId: 'a', toId: 'b' }],
  };
  const parsed = parseSnapshot(
    {
      evidence: [
        { id: 'a', title: '卡片A' },
        { id: 'b', title: '卡片B 改名', source: '日志', occurredAt: '2026-03-12T02:15' },
        { title: '无 id 新卡片' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    },
    NOW,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');

  const diff = computeImportDiff(current, { cards: parsed.cards, edges: parsed.edges });
  assert.equal(diff.counts.addedCards, 1);
  assert.equal(diff.addedCards[0].title, '无 id 新卡片');
  assert.deepEqual(diff.removedCards.map((c0) => c0.id), ['c']);
  assert.deepEqual(diff.modifiedCards.map((c0) => c0.id), ['b']);
  const fields = new Map(diff.modifiedCards[0].changes.map((ch) => [ch.field, ch]));
  assert.equal(fields.get('title')?.before, '卡片B');
  assert.equal(fields.get('title')?.after, '卡片B 改名');
  assert.equal(fields.get('occurredAt')?.before, '');
  assert.equal(fields.get('occurredAt')?.after, '2026-03-12T02:15');
  assert.equal(fields.has('source'), false);
  assert.deepEqual(diff.counts, {
    addedCards: 1,
    removedCards: 1,
    modifiedCards: 1,
    addedEdges: 0,
    removedEdges: 0,
  });
});

test('computeImportDiff：连线按两端 id 配对比较新增与删除', () => {
  const cards = [card('a', { title: 'A' }), card('b', { title: 'B' }), card('c', { title: 'C' })];
  const current = {
    evidence: cards,
    edges: [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
    ],
  };
  const snapshot = {
    cards,
    edges: [
      { fromId: 'a', toId: 'b' },
      { fromId: 'a', toId: 'c' },
    ],
  };
  const diff = computeImportDiff(current, snapshot);
  assert.equal(diff.counts.addedEdges, 1);
  assert.deepEqual([diff.addedEdges[0].fromId, diff.addedEdges[0].toId], ['a', 'c']);
  assert.equal(diff.counts.removedEdges, 1);
  assert.deepEqual([diff.removedEdges[0].fromId, diff.removedEdges[0].toId], ['b', 'c']);
  assert.equal(diff.counts.modifiedCards, 0);
});

test('computeImportDiff：无变化时全部为空', () => {
  const current = {
    evidence: [card('a', { title: 'A' }), card('b', { title: 'B' })],
    edges: [{ fromId: 'a', toId: 'b' }],
  };
  const snapshot = {
    cards: [card('a', { title: 'A' }), card('b', { title: 'B' })],
    edges: [{ fromId: 'a', toId: 'b' }],
  };
  assert.deepEqual(computeImportDiff(current, snapshot).counts, {
    addedCards: 0,
    removedCards: 0,
    modifiedCards: 0,
    addedEdges: 0,
    removedEdges: 0,
  });
});

test('parseSnapshot：结构错误、重复 id、未知端点、字段非法均拒绝', () => {
  assert.equal(parseSnapshot({}, NOW).ok, false);
  assert.equal(
    parseSnapshot({ evidence: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], edges: [] }, NOW).ok,
    false,
  );
  assert.equal(
    parseSnapshot({ evidence: [{ id: 'a', title: 'A' }], edges: [{ from: 'a', to: 'x' }] }, NOW).ok,
    false,
  );
  assert.equal(parseSnapshot({ evidence: [{ id: 'a', title: '' }], edges: [] }, NOW).ok, false);
  assert.equal(
    parseSnapshot({ evidence: [{ id: 'a', title: 'A', occurredAt: '不是时间' }], edges: [] }, NOW).ok,
    false,
  );
});

test('parseSnapshot：无 id 卡片分配新 id，from/to 与 fromId/toId 两种连线字段都兼容', () => {
  const r = parseSnapshot(
    {
      evidence: [{ title: '新卡1' }, { id: 'b', title: 'B' }],
      edges: [{ fromId: 'b', to: 'b' }],
    },
    NOW,
  );
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  const idless = r.cards.find((c0) => !c0.hadId);
  assert.ok(idless && /^[0-9a-f-]{36}$/.test(idless.id));
  assert.equal(r.edges.length, 1);
});

test('graphFingerprint：内容相同则相同；卡片字段或连线变化则不同', () => {
  const evidence = [card('a', { title: 'A' }), card('b', { title: 'B' })];
  const edges = [{ fromId: 'a', toId: 'b' }];
  const fp1 = graphFingerprint(evidence, edges);
  assert.equal(fp1, graphFingerprint(evidence, edges));
  assert.notEqual(fp1, graphFingerprint(evidence, [{ fromId: 'b', toId: 'a' }]));
  assert.notEqual(fp1, graphFingerprint([card('a', { title: 'A2' }), card('b')], edges));
});

test('snapshotHash：绑定文件原文，逐字节变化即不同', () => {
  assert.equal(snapshotHash('{}'), snapshotHash('{}'));
  assert.notEqual(snapshotHash('{}'), snapshotHash('{ }'));
});

test('预览令牌：文件或图与预览时不一致即拒绝；删除令牌后按过期拒绝', () => {
  const token = createPreviewToken(snapshotHash('file'), graphFingerprint([card('a')], []));
  assert.equal(checkPreviewToken(token, snapshotHash('file'), graphFingerprint([card('a')], [])).ok, true);

  const changedFile = checkPreviewToken(token, snapshotHash('other'), graphFingerprint([card('a')], []));
  assert.equal(changedFile.ok, false);
  if (changedFile.ok) throw new Error('unreachable');
  assert.equal(changedFile.reason, 'file-changed');

  const changedGraph = checkPreviewToken(token, snapshotHash('file'), graphFingerprint([card('a', { title: 'X' })], []));
  assert.equal(changedGraph.ok, false);
  if (changedGraph.ok) throw new Error('unreachable');
  assert.equal(changedGraph.reason, 'graph-changed');

  deletePreviewToken(token);
  const expired = checkPreviewToken(token, snapshotHash('file'), graphFingerprint([card('a')], []));
  assert.equal(expired.ok, false);
  if (expired.ok) throw new Error('unreachable');
  assert.equal(expired.reason, 'token-expired');
});
