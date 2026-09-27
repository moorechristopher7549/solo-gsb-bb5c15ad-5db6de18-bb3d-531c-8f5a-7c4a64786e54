import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeMustPass,
  analyzeTimeWindow,
  cycleAfterAdding,
  findBypassPath,
  findCycle,
  findPath,
  findRedundantEdges,
  mergeConflict,
  planMergeEdges,
  planPrune,
  queryOrder,
  stableTopoOrder,
  topoLevels,
} from '../src/graph';

test('合法连线：不成环时返回 null', () => {
  const edges = [{ fromId: 'a', toId: 'b' }];
  assert.equal(cycleAfterAdding(edges, { fromId: 'b', toId: 'c' }), null);
});

test('成环连线：返回完整闭环节点序列', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  // 新增 c → a 将构成 a → b → c → a
  assert.deepEqual(cycleAfterAdding(edges, { fromId: 'c', toId: 'a' }), ['c', 'a', 'b', 'c']);
});

test('自环立即被拒绝', () => {
  assert.deepEqual(cycleAfterAdding([], { fromId: 'a', toId: 'a' }), ['a', 'a']);
});

test('findPath：沿边方向找到路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  assert.deepEqual(findPath(edges, 'a', 'c'), ['a', 'c']);
  assert.equal(findPath(edges, 'c', 'a'), null);
});

test('topoLevels：按最长路径分层', () => {
  const levels = topoLevels(
    ['a', 'b', 'c', 'd'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
      { fromId: 'a', toId: 'c' },
      { fromId: 'c', toId: 'd' },
    ],
  );
  assert.deepEqual(levels, { a: 0, b: 1, c: 2, d: 3 });
});

test('topoLevels：有环时返回 null', () => {
  const levels = topoLevels(
    ['a', 'b'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'a' },
    ],
  );
  assert.equal(levels, null);
});

test('findCycle：在已有图中定位闭环', () => {
  const cycle = findCycle(
    ['a', 'b', 'c', 'd'],
    [
      { fromId: 'a', toId: 'b' },
      { fromId: 'b', toId: 'c' },
      { fromId: 'c', toId: 'a' },
      { fromId: 'c', toId: 'd' },
    ],
  );
  assert.ok(cycle);
  assert.equal(cycle![0], cycle![cycle!.length - 1]);
  assert.equal(cycle!.length, 4);
});

test('findCycle：无环返回 null', () => {
  const cycle = findCycle(
    ['a', 'b'],
    [{ fromId: 'a', toId: 'b' }],
  );
  assert.equal(cycle, null);
});

/* ---------- 传递约简（约束瘦身） ---------- */

test('findRedundantEdges：三角结构中的直达边冗余，并给出最短替代路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.equal(redundant.length, 1);
  assert.deepEqual(redundant[0].edge, { fromId: 'a', toId: 'c' });
  assert.deepEqual(redundant[0].path, ['a', 'b', 'c']);
});

test('findRedundantEdges：链式结构没有冗余边', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  assert.deepEqual(findRedundantEdges(edges), []);
});

test('findRedundantEdges：菱形结构中替代路径取最短（边数最少）', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'c', toId: 'd' },
    { fromId: 'a', toId: 'e' },
    { fromId: 'e', toId: 'd' },
    { fromId: 'a', toId: 'd' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.equal(redundant.length, 1);
  assert.deepEqual(redundant[0].edge, { fromId: 'a', toId: 'd' });
  // a→e→d（2 条边）比 a→b→c→d（3 条边）更短
  assert.deepEqual(redundant[0].path, ['a', 'e', 'd']);
});

test('findRedundantEdges：多条冗余边各自给出替代路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
    { fromId: 'c', toId: 'd' },
    { fromId: 'a', toId: 'd' },
  ];
  const redundant = findRedundantEdges(edges);
  assert.deepEqual(
    redundant.map((r) => `${r.edge.fromId}->${r.edge.toId}`).sort(),
    ['a->c', 'a->d'],
  );
  const ad = redundant.find((r) => r.edge.toId === 'd')!;
  assert.deepEqual(ad.path, ['a', 'c', 'd']);
});

test('planPrune：逐条复核，跳过当前并不冗余的连线', () => {
  // a→b 冗余（替代路径 a→c→b）；a→c 从不冗余（忽略自身后 a 到不了 c）
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'a', toId: 'c' },
    { id: 3, fromId: 'c', toId: 'b' },
  ];
  const plan = planPrune(edges, [1, 2]);
  assert.deepEqual(plan.remove.map((e) => e.id), [1]);
  assert.deepEqual(plan.skipped, [2]);
});

test('planPrune：DAG 上所有冗余边无论请求顺序都会被移除（传递约简唯一）', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'c', toId: 'd' },
    { id: 5, fromId: 'a', toId: 'd' },
  ];
  for (const ids of [[3, 5], [5, 3], [1, 2, 3, 4, 5]]) {
    const plan = planPrune(edges, ids);
    assert.deepEqual(plan.remove.map((e) => e.id).sort(), [3, 5]);
  }
});

test('planPrune：独立冗余边可全部移除，未知 id 被跳过', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'x', toId: 'y' },
    { id: 5, fromId: 'y', toId: 'z' },
    { id: 6, fromId: 'x', toId: 'z' },
  ];
  const plan = planPrune(edges, [3, 6, 999, 3]);
  assert.deepEqual(plan.remove.map((e) => e.id), [3, 6]);
  assert.deepEqual(plan.skipped, [999]);
});

test('planPrune：移除后各节点间可达关系保持不变', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 'b' },
    { id: 2, fromId: 'b', toId: 'c' },
    { id: 3, fromId: 'a', toId: 'c' },
    { id: 4, fromId: 'c', toId: 'd' },
    { id: 5, fromId: 'a', toId: 'd' },
  ];
  const reachableBefore = (from: string, to: string) => findPath(edges, from, to) !== null;
  const { remove } = planPrune(edges, [1, 2, 3, 4, 5]);
  const remaining = edges.filter((e) => !remove.includes(e));
  for (const from of ['a', 'b', 'c', 'd']) {
    for (const to of ['a', 'b', 'c', 'd']) {
      assert.equal(findPath(remaining, from, to) !== null, reachableBefore(from, to), `${from}⇝${to} 可达性应保持不变`);
    }
  }
});

/* ---------- 顺序确定性查询 ---------- */

const nodesOf = (ids: string[]) => ids.map((id, i) => ({ id, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }));

test('stableTopoOrder：并列节点按创建时间、再按 id 稳定排序', () => {
  const nodes = [
    { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  // 无边：完全按 (createdAt, id) 排序；a 与 c 创建时间相同，按 id 决出
  assert.deepEqual(stableTopoOrder(nodes, []), ['a', 'c', 'b']);
});

test('stableTopoOrder：遵守约束且结果确定', () => {
  const nodes = nodesOf(['x', 'y', 'z']);
  const edges = [{ fromId: 'z', toId: 'x' }];
  // z 必须先于 x；y 无约束，按创建时间排最前
  assert.deepEqual(stableTopoOrder(nodes, edges), ['y', 'z', 'x']);
});

test('stableTopoOrder：附加见证边后仍满足全部约束；附加边成环时返回 null', () => {
  const nodes = nodesOf(['a', 'b']);
  const order = stableTopoOrder(nodes, [], { fromId: 'b', toId: 'a' })!;
  assert.ok(order.indexOf('b') < order.indexOf('a'));
  // 已有 a→b 时再附加 b→a 构成环
  assert.equal(stableTopoOrder(nodes, [{ fromId: 'a', toId: 'b' }], { fromId: 'b', toId: 'a' }), null);
});

test('queryOrder：A 必须早于 B，返回最短约束路径', () => {
  const nodes = nodesOf(['a', 'b', 'c']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  const r = queryOrder(nodes, edges, 'a', 'c')!;
  assert.equal(r.relation, 'a-before-b');
  assert.deepEqual(r.path, ['a', 'c']); // 最短路径为直达边
  assert.equal(r.witnesses, null);
});

test('queryOrder：B 必须早于 A（反向可达）', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'b', toId: 'a' }];
  const r = queryOrder(nodes, edges, 'a', 'b')!;
  assert.equal(r.relation, 'b-before-a');
  assert.deepEqual(r.path, ['b', 'a']);
  assert.equal(r.witnesses, null);
});

test('queryOrder：顺序未被约束时给出双向见证拓扑序', () => {
  const nodes = nodesOf(['a', 'b', 'c', 'd']);
  const edges = [
    { fromId: 'a', toId: 'c' },
    { fromId: 'b', toId: 'd' },
  ];
  const r = queryOrder(nodes, edges, 'a', 'b')!;
  assert.equal(r.relation, 'unconstrained');
  assert.equal(r.path, null);
  const { aFirst, bFirst } = r.witnesses!;
  const assertTopoOrder = (order: string[], extra: { fromId: string; toId: string }) => {
    assert.deepEqual([...order].sort(), ['a', 'b', 'c', 'd']);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const e of [...edges, extra]) {
      assert.ok(pos.get(e.fromId)! < pos.get(e.toId)!, `${e.fromId} 应排在 ${e.toId} 之前`);
    }
  };
  assertTopoOrder(aFirst, { fromId: 'a', toId: 'b' });
  assertTopoOrder(bFirst, { fromId: 'b', toId: 'a' });
  // 并列节点按创建时间稳定排序：a 创建最早且初始就绪，排在首位
  assert.equal(aFirst[0], 'a');
  assert.equal(bFirst[0], 'b');
});

test('queryOrder：同一卡片返回 null', () => {
  assert.equal(queryOrder(nodesOf(['a']), [], 'a', 'a'), null);
});

/* ---------- 必经证据分析 ---------- */

test('analyzeMustPass：链式结构中所有中间卡片均为必经，按约束先后排序', () => {
  const nodes = nodesOf(['a', 'b', 'c', 'd']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'c', toId: 'd' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'd')!;
  assert.equal(r.reachable, true);
  assert.equal(r.direct, false);
  assert.deepEqual(r.mustPass, ['b', 'c']);
  assert.deepEqual(r.optional, []);
});

test('analyzeMustPass：菱形结构没有必经中间卡片，中间卡片均可绕开', () => {
  const nodes = nodesOf(['a', 'b', 'c', 'd']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'a', toId: 'c' },
    { fromId: 'b', toId: 'd' },
    { fromId: 'c', toId: 'd' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'd')!;
  assert.equal(r.reachable, true);
  assert.equal(r.direct, false);
  assert.deepEqual(r.mustPass, []);
  assert.deepEqual(r.optional.sort(), ['b', 'c']);
});

test('analyzeMustPass：有直接连线时必经中间卡片为空，其余中间卡片可绕开', () => {
  const nodes = nodesOf(['a', 'b', 'c']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'a', toId: 'c' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'c')!;
  assert.equal(r.reachable, true);
  assert.equal(r.direct, true);
  assert.deepEqual(r.mustPass, []);
  assert.deepEqual(r.optional, ['b']);
});

test('analyzeMustPass：分叉前的共同路段必经，分支上的卡片可互相绕开', () => {
  // a→b→{c,d}→e：b 是所有 a→e 路径的共同中间卡片；c 与 d 互为可绕开支路
  const nodes = nodesOf(['a', 'b', 'c', 'd', 'e']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
    { fromId: 'b', toId: 'd' },
    { fromId: 'c', toId: 'e' },
    { fromId: 'd', toId: 'e' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'e')!;
  assert.equal(r.reachable, true);
  assert.deepEqual(r.mustPass, ['b']);
  assert.deepEqual(r.optional.sort(), ['c', 'd']);
});

test('analyzeMustPass：必经卡片按约束先后（拓扑）而非创建时间排序', () => {
  // 创建时间 c 早于 d，但约束链为 a→d→c→b
  const nodes = [
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'd', createdAt: '2026-01-04T00:00:00.000Z' },
  ];
  const edges = [
    { fromId: 'a', toId: 'd' },
    { fromId: 'd', toId: 'c' },
    { fromId: 'c', toId: 'b' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'b')!;
  assert.deepEqual(r.mustPass, ['d', 'c']);
});

test('analyzeMustPass：不可达时 reachable=false 且结果为空', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'b', toId: 'a' }];
  const r = analyzeMustPass(nodes, edges, 'a', 'b')!;
  assert.equal(r.reachable, false);
  assert.equal(r.direct, false);
  assert.deepEqual(r.mustPass, []);
  assert.deepEqual(r.optional, []);
});

test('analyzeMustPass：不在任何 A→B 路径上的卡片不参与结果', () => {
  const nodes = nodesOf(['a', 'b', 'x']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'x', toId: 'b' },
  ];
  const r = analyzeMustPass(nodes, edges, 'a', 'b')!;
  assert.deepEqual(r.mustPass, []);
  assert.deepEqual(r.optional, []);
});

test('analyzeMustPass：同一卡片返回 null；有环图返回 null', () => {
  const nodes = nodesOf(['a', 'b']);
  assert.equal(analyzeMustPass(nodes, [], 'a', 'a'), null);
  const cyclic = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'a' },
  ];
  assert.equal(analyzeMustPass(nodes, cyclic, 'a', 'b'), null);
});

test('findBypassPath：绕开非必经卡片给出真实最短路径', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'a', toId: 'c' },
    { fromId: 'b', toId: 'd' },
    { fromId: 'c', toId: 'd' },
  ];
  assert.deepEqual(findBypassPath(edges, 'a', 'd', 'b'), ['a', 'c', 'd']);
  assert.deepEqual(findBypassPath(edges, 'a', 'd', 'c'), ['a', 'b', 'd']);
});

test('findBypassPath：必经卡片无法绕开；不能绕开起点或终点', () => {
  const chain = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'd' },
  ];
  assert.equal(findBypassPath(chain, 'a', 'd', 'b'), null);
  assert.equal(findBypassPath(chain, 'a', 'd', 'a'), null);
  assert.equal(findBypassPath(chain, 'a', 'd', 'd'), null);
  // A 根本不可达 B 时同样为 null

  assert.equal(findBypassPath(chain, 'd', 'a', 'b'), null);
});

/* ---------- 重复证据合并 ---------- */

test('mergeConflict：无关节点合并无冲突', () => {
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'c', toId: 'd' },
  ];
  assert.equal(mergeConflict(edges, 'a', 'c'), null);
  assert.equal(mergeConflict(edges, 'd', 'b'), null);
});

test('mergeConflict：直接约束改接成自环，返回 self-loop 与两端点', () => {
  const edges = [{ fromId: 's', toId: 't' }];
  assert.deepEqual(mergeConflict(edges, 's', 't'), { kind: 'self-loop', path: ['s', 't'] });
  assert.deepEqual(mergeConflict(edges, 't', 's'), { kind: 'self-loop', path: ['s', 't'] });
});

test('mergeConflict：源可达保留（无直连），改接后成环，返回 cycle 路径', () => {
  // s → x → t：s 可达 t。改接入边会让 t 沿路径回到 s 再指向 t，形成闭环
  const edges = [
    { fromId: 's', toId: 'x' },
    { fromId: 'x', toId: 't' },
  ];
  const c = mergeConflict(edges, 's', 't')!;
  assert.equal(c.kind, 'cycle');
  assert.deepEqual(c.path, ['s', 'x', 't']);
});

test('mergeConflict：保留可达源（无直连），改接入边成环，返回反方向 cycle 路径', () => {
  const edges = [
    { fromId: 't', toId: 'x' },
    { fromId: 'x', toId: 's' },
  ];
  const c = mergeConflict(edges, 's', 't')!;
  assert.equal(c.kind, 'cycle');
  assert.deepEqual(c.path, ['t', 'x', 's']);
});

test('planMergeEdges：全部入边、出边改接到保留卡', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'x', toId: 'y' },
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.rewire, [
    { id: 1, fromId: 'a', toId: 't' },
    { id: 2, fromId: 't', toId: 'b' },
  ]);
});

test('planMergeEdges：重复连线只留保留卡侧一条，删除源侧重复边', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' }, // 改接为 a→t
    { id: 2, fromId: 'a', toId: 't' }, // 已存在 a→t：边 1 重复，删除
    { id: 3, fromId: 's', toId: 'b' }, // 改接为 t→b
    { id: 4, fromId: 't', toId: 'b' }, // 已存在 t→b：边 3 重复，删除
    { id: 5, fromId: 's', toId: 'c' }, // 无重复：改接为 t→c
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds.sort(), [1, 3]);
  assert.deepEqual(plan.rewire, [{ id: 5, fromId: 't', toId: 'c' }]);
});

test('planMergeEdges：与源卡无关的连线原样保留', () => {
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'x', toId: 'y' },
    { id: 4, fromId: 't', toId: 'z' },
  ];
  const plan = planMergeEdges(edges, 's', 't');
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.rewire.map((e) => e.id).sort(), [1, 2]);
});

test('合并改接（去重后）不产生环，剩余图仍然无环', () => {
  // 可合并的场景：s 与 t 互不达
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 's', toId: 'b' },
    { id: 3, fromId: 'c', toId: 't' },
  ];
  assert.equal(mergeConflict(edges, 's', 't'), null);
  const plan = planMergeEdges(edges, 's', 't');
  const remaining = edges
    .filter((e) => !plan.deleteIds.includes(e.id))
    .map((e) => {
      const m = plan.rewire.find((r) => r.id === e.id);
      return m ? { fromId: m.fromId, toId: m.toId } : { fromId: e.fromId, toId: e.toId };
    })
    .filter((e) => e.fromId !== 's' && e.toId !== 's');
  const ids = ['a', 'b', 'c', 't'];
  assert.notEqual(topoLevels(ids, remaining), null);
});

test('事务模拟：任意可合并场景执行计划后无重复连线、无自环、无环', () => {
  // 较复杂场景：s 同时有多个入边/出边，部分与保留卡侧重复
  const edges = [
    { id: 1, fromId: 'a', toId: 's' },
    { id: 2, fromId: 'b', toId: 's' },
    { id: 3, fromId: 'a', toId: 't' }, // a→t 已存在 => 边 1 改接后重复
    { id: 4, fromId: 's', toId: 'c' },
    { id: 5, fromId: 't', toId: 'd' },
    { id: 6, fromId: 's', toId: 'd' }, // t→d 已存在 => 边 6 重复
    { id: 7, fromId: 'x', toId: 'y' }, // 完全无关
  ];
  assert.equal(mergeConflict(edges, 's', 't'), null);
  const plan = planMergeEdges(edges, 's', 't');
  const finalEdges = edges
    .filter((e) => !plan.deleteIds.includes(e.id))
    .map((e) => plan.rewire.find((r) => r.id === e.id) ?? e)
    .filter((e) => e.fromId !== 's' && e.toId !== 's');

  // 无自环
  assert.ok(finalEdges.every((e) => e.fromId !== e.toId));
  // 无重复 (from, to) 对（对应 edges 表 UNIQUE(from_id, to_id)）
  const keys = finalEdges.map((e) => `${e.fromId}->${e.toId}`);
  assert.equal(new Set(keys).size, keys.length);
  // 无环
  assert.equal(findCycle(['a', 'b', 'c', 'd', 'x', 'y', 't'], finalEdges), null);
  // 保留卡继承了去重后的邻接：a→t 仅一条，t→c、t→d 各一条
  assert.deepEqual(
    keys.sort(),
    ['a->t', 'b->t', 't->c', 't->d', 'x->y'],
  );
});

/* ---------- 时间窗口分析（沿 DAG 双向传播上下界） ---------- */

const T = (h: number, m = 0) => Date.UTC(2026, 2, 12, h, m); // 2026-03-12 hh:mm（UTC 墙钟轴）
const GAP = 60 * 60_000; // 1 小时间隔（毫秒）

const fixedMap = (rec: Record<string, number | null>): Map<string, number | null> => new Map(Object.entries(rec));

test('analyzeTimeWindow：孤立卡仅受事故闭区间限制（最早=起点、最晚=终点）', () => {
  const r = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: null }), T(2), T(5), GAP)!;
  assert.equal(r.feasible, true);
  assert.deepEqual(r.cards.map((c) => [c.cardId, c.earliestMs, c.latestMs, c.fixed]), [['x', T(2), T(5), false]]);
});

test('analyzeTimeWindow：固定卡可行时最早与最晚为同一时刻', () => {
  const r = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: T(3) }), T(2), T(5), GAP)!;
  assert.equal(r.feasible, true);
  assert.equal(r.cards[0].earliestMs, T(3));
  assert.equal(r.cards[0].latestMs, T(3));
  assert.equal(r.cards[0].fixed, true);
});

test('analyzeTimeWindow：固定时刻早于区间起点 → 越界（before-start），不做传播', () => {
  const r = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: T(1) }), T(2), T(5), GAP)!;
  assert.equal(r.feasible, false);
  assert.deepEqual(r.outOfRange, [{ cardId: 'x', fixedAtMs: T(1), side: 'before-start' }]);
  assert.equal(r.conflict, null);
  assert.deepEqual(r.cards, []);
});

test('analyzeTimeWindow：固定时刻晚于区间终点 → 越界（after-end）', () => {
  const r = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: T(6) }), T(2), T(5), GAP)!;
  assert.equal(r.feasible, false);
  assert.deepEqual(r.outOfRange, [{ cardId: 'x', fixedAtMs: T(6), side: 'after-end' }]);
});

test('analyzeTimeWindow：固定时刻恰为区间端点合法（闭区间）', () => {
  const r1 = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: T(2) }), T(2), T(5), GAP)!;
  const r2 = analyzeTimeWindow(nodesOf(['x']), [], fixedMap({ x: T(5) }), T(2), T(5), GAP)!;
  assert.equal(r1.feasible, true);
  assert.equal(r2.feasible, true);
});

test('analyzeTimeWindow：链式 a→b→c 正向最早时刻逐级加间隔、反向最晚逐级减间隔', () => {
  const nodes = nodesOf(['a', 'b', 'c']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: null, b: null, c: null }), T(2), T(6), GAP)!;
  assert.equal(r.feasible, true);
  const m = new Map(r.cards.map((c) => [c.cardId, c]));
  assert.deepEqual([m.get('a')!.earliestMs, m.get('a')!.latestMs], [T(2), T(4)]);
  assert.deepEqual([m.get('b')!.earliestMs, m.get('b')!.latestMs], [T(3), T(5)]);
  assert.deepEqual([m.get('c')!.earliestMs, c_latest(m, 'c')], [T(4), T(6)]);
});

function c_latest(m: Map<string, { earliestMs: number; latestMs: number }>, id: string): number {
  return m.get(id)!.latestMs;
}

test('analyzeTimeWindow：空时间卡参与推导（前驱固定时刻把空卡的下界推后）', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'a', toId: 'b' }];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: T(3), b: null }), T(2), T(6), GAP)!;
  assert.equal(r.feasible, true);
  const m = new Map(r.cards.map((c) => [c.cardId, c]));
  assert.deepEqual([m.get('a')!.earliestMs, m.get('a')!.latestMs], [T(3), T(3)]);
  assert.deepEqual([m.get('b')!.earliestMs, m.get('b')!.latestMs], [T(4), T(6)]);
});

test('analyzeTimeWindow：后继固定时刻把空卡的上界提前', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'a', toId: 'b' }];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: null, b: T(4) }), T(2), T(6), GAP)!;
  assert.equal(r.feasible, true);
  const m = new Map(r.cards.map((c) => [c.cardId, c]));
  assert.deepEqual([m.get('a')!.earliestMs, m.get('a')!.latestMs], [T(2), T(3)]);
  assert.deepEqual([m.get('b')!.earliestMs, m.get('b')!.latestMs], [T(4), T(4)]);
});

test('analyzeTimeWindow：两张固定卡间隔不足 → 上下界冲突，路径为真实约束边', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'a', toId: 'b' }];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: T(3), b: T(3) }), T(2), T(6), GAP)!;
  assert.equal(r.feasible, false);
  assert.deepEqual(r.outOfRange, []);
  assert.ok(r.conflict);
  // 冲突点为首张上下界矛盾的卡片 a：固定 03:00（下界），但要给 b 留出 1 小时间隔只能 ≤ 02:00（上界）
  assert.equal(r.conflict!.pivotId, 'a');
  assert.equal(r.conflict!.lowerAtMs, T(3));
  assert.equal(r.conflict!.upperAtMs, T(2));
  assert.deepEqual(r.conflict!.path, ['a', 'b']);
  assert.equal(r.conflict!.lowerAnchor, 'fixed');
  assert.equal(r.conflict!.lowerAnchorCardId, 'a');
  assert.equal(r.conflict!.upperAnchor, 'fixed');
  assert.equal(r.conflict!.upperAnchorCardId, 'b');
});

test('analyzeTimeWindow：区间过短容不下链长 → 区间起点/终点经路径冲突', () => {
  // a→b→c 共需 2 个间隔；区间 [02:00, 03:00] 仅 60 分钟，容不下
  const nodes = nodesOf(['a', 'b', 'c']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'c' },
  ];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: null, b: null, c: null }), T(2), T(3), GAP)!;
  assert.equal(r.feasible, false);
  assert.ok(r.conflict);
  // 冲突点为链首 a：区间起点要求 ≥ 02:00，但要在 03:00 前留出 2 个间隔只能 ≤ 01:00
  assert.equal(r.conflict!.pivotId, 'a');
  assert.equal(r.conflict!.lowerAtMs, T(2));
  assert.equal(r.conflict!.upperAtMs, T(1));
  assert.deepEqual(r.conflict!.path, ['a', 'b', 'c']);
  assert.equal(r.conflict!.lowerAnchor, 'window-start');
  assert.equal(r.conflict!.upperAnchor, 'window-end');
  assert.equal(r.conflict!.lowerAnchorCardId, null);
  assert.equal(r.conflict!.upperAnchorCardId, null);
});

test('analyzeTimeWindow：固定锚点与区间锚点经真实路径冲突（菱形取最长上界链）', () => {
  // 菱形 a→b→d、a→c→d：a 固定 03:00，d 的下界取最长路径 03:00+2×gap=05:00；
  // 区间终点 04:30 使 a 的上界经最长链被压到 02:30，与固定时刻冲突
  const nodes = nodesOf(['a', 'b', 'c', 'd']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'a', toId: 'c' },
    { fromId: 'b', toId: 'd' },
    { fromId: 'c', toId: 'd' },
  ];
  const r = analyzeTimeWindow(
    nodes,
    edges,
    fixedMap({ a: T(3), b: null, c: null, d: null }),
    T(2),
    T(4, 30),
    GAP,
  )!;
  assert.equal(r.feasible, false);
  assert.ok(r.conflict);
  assert.equal(r.conflict!.pivotId, 'a');
  assert.equal(r.conflict!.lowerAtMs, T(3));
  assert.equal(r.conflict!.upperAtMs, T(2, 30));
  // 路径相邻节点必须都是图中真实边
  const p = r.conflict!.path;
  const edgeSet = new Set(edges.map((e) => `${e.fromId}->${e.toId}`));
  for (let i = 0; i < p.length - 1; i++) assert.ok(edgeSet.has(`${p[i]}->${p[i + 1]}`), `路径段 ${p[i]}→${p[i + 1]} 应为真实约束`);
  assert.deepEqual(p, ['a', 'b', 'd']); // b < c，取稳定的最长链
  assert.equal(r.conflict!.lowerAnchor, 'fixed');
  assert.equal(r.conflict!.lowerAnchorCardId, 'a');
  assert.equal(r.conflict!.upperAnchor, 'window-end');
  assert.equal(r.conflict!.upperAnchorCardId, null);
});

test('analyzeTimeWindow：无向关联的组件互不影响，各自可行', () => {
  const nodes = nodesOf(['a', 'b', 'x', 'y']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'x', toId: 'y' },
  ];
  const r = analyzeTimeWindow(
    nodes,
    edges,
    fixedMap({ a: T(2), b: T(3), x: T(4), y: T(5) }),
    T(2),
    T(5),
    GAP,
  )!;
  assert.equal(r.feasible, true);
});

test('analyzeTimeWindow：多张越界固定卡全部列出（按拓扑序）', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [{ fromId: 'a', toId: 'b' }];
  const r = analyzeTimeWindow(nodes, edges, fixedMap({ a: T(1), b: T(8) }), T(2), T(6), GAP)!;
  assert.equal(r.feasible, false);
  assert.deepEqual(r.outOfRange, [
    { cardId: 'a', fixedAtMs: T(1), side: 'before-start' },
    { cardId: 'b', fixedAtMs: T(8), side: 'after-end' },
  ]);
});

test('analyzeTimeWindow：有环图返回 null', () => {
  const nodes = nodesOf(['a', 'b']);
  const edges = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'b', toId: 'a' },
  ];
  assert.equal(analyzeTimeWindow(nodes, edges, fixedMap({ a: null, b: null }), T(2), T(5), GAP), null);
});
