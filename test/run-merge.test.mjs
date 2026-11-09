// P1 동시 시작 · 병합 줄, P2 범위 위반 FAIL(가짜 어댑터 + 로컬 bare 저장소).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan } from '../lib/run.mjs';
import { git, showFile, listTree } from '../lib/gitops.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { loadState, formatStatus } from '../lib/status.mjs';
import { makeHeadMailbox } from '../lib/run.mjs';
import { setupRepo, calcPlan, mockAdapters, implement, approved } from './helpers.mjs';

test('P1: 조각 3개가 동시에 시작하고(차 < 2초) integration에 차례로 합쳐지고 전체 시험이 통과한다', async () => {
  const env = await setupRepo();
  const plan = calcPlan('p1');
  await approved(env, plan);
  const adapters = await mockAdapters(env, env.runDir);
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.status, 'DONE');
  assert.deepEqual(res.pieces, { add: 'MERGED', mul: 'MERGED', format: 'MERGED' });

  const starts = readLedger(env.runDir).filter((e) => e.action === 'start');
  assert.equal(starts.length, 3);
  const times = starts.map((e) => Date.parse(e.startedAt));
  assert.ok(Math.max(...times) - Math.min(...times) < 2000, `시작 시각 차 ${Math.max(...times) - Math.min(...times)}ms`);
  // 가짜 에이전트 쪽 실제 착수 시각도 2초 안
  const begun = Object.values(adapters).flatMap((a) => a.starts.filter((s) => s.mode === 'author').map((s) => s.at));
  assert.ok(Math.max(...begun) - Math.min(...begun) < 2000);

  const integ = 'origin/trio/p1/integration';
  await git(env.work, ['fetch', '--quiet', 'origin']);
  const subjects = (await git(env.work, ['log', '--first-parent', '--format=%s', `origin/trio/p1/base..${integ}`])).trim().split('\n').reverse();
  assert.deepEqual(subjects, ['trio: add 합치기', 'trio: mul 합치기', 'trio: format 합치기'], '의존 순서대로 하나씩');
  for (const f of ['src/add.js', 'src/mul.js', 'src/format.js', 'test/format.test.js', 'src/types.js']) {
    assert.ok(await showFile(env.work, integ, f), `${f}가 integration에 있다`);
  }
  assert.equal((await listTree(env.work, integ, '.trio/outbox')).length, 0);
  assert.equal(await showFile(env.work, 'origin/main', 'src/add.js'), null, 'main에는 쓰지 않는다');

  // 계약 + ORDER는 base에, 조각 브랜치는 base에서 시작
  const order = JSON.parse(await showFile(env.work, 'origin/trio/p1/base', '.trio/orders/mul.json'));
  assert.deepEqual(order.allowed_paths, ['src/mul.js', 'test/mul.test.js']);
  assert.ok(order.protected_paths.includes('src/types.js'));
  const baseSha = (await git(env.work, ['rev-parse', 'origin/trio/p1/base'])).trim();
  const mb = (await git(env.work, ['merge-base', 'origin/trio/p1/base', 'origin/trio/p1/add'])).trim();
  assert.equal(mb, baseSha);

  // 검토자는 늘 다른 회사, 검토 기록이 남는다
  const reviews = readLedger(env.runDir).filter((e) => e.action === 'review');
  assert.deepEqual(reviews.map((r) => `${r.piece}:${r.agent}`).sort(), ['add:codex', 'format:claude', 'mul:antigravity']);

  // B1 · B2: 검토를 통과한 커밋과 HEAD가 만든 base · integration SHA를 기록한다
  const st = loadState(env.runDir);
  assert.match(st.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(st.baseSha, baseSha);
  assert.equal((await git(env.work, ['rev-parse', 'origin/trio/p1/integration'])).trim(), st.integrationSha);
  for (const id of ['add', 'mul', 'format']) {
    assert.equal(st.pieces[id].passedSha, (await git(env.work, ['rev-parse', `origin/trio/p1/${id}`])).trim(), `${id}: 검토한 커밋 = 합친 커밋`);
  }
  // 정상 흐름에서는 전달함 감사 위반이 없다
  assert.equal(readLedger(env.runDir).filter((e) => e.action === 'mailbox-audit' && e.result === 'violation').length, 0);
  const table = formatStatus(loadState(env.runDir), { heartbeats: await makeHeadMailbox(env.work, env.runDir, 'p1').readHeartbeats() });
  for (const id of ['add', 'mul', 'format']) assert.match(table, new RegExp(`${id}.*MERGED`));
  const dec = await makeHeadMailbox(env.work, env.runDir, 'p1').readDecisions();
  assert.ok(dec.some((d) => d.includes('계약 고정')));
});

test('P2: allowed_paths 밖을 고친 조각은 FAIL, 작성자 상자에 이유 편지, integration에 없음', async () => {
  const env = await setupRepo();
  const plan = calcPlan('p2');
  await approved(env, plan);
  const adapters = await mockAdapters(env, env.runDir, {
    codex: { author: implement({ 'src/add.js': 'export const hijack = 1;\n', 'README.md': '바꿈\n' }) },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.pieces.mul, 'SCOPE_FAILED');
  assert.equal(res.pieces.add, 'MERGED');
  assert.equal(res.pieces.format, 'DEP_FAILED', 'mul에 의존하는 조각도 합치지 않는다');

  const box = await makeHeadMailbox(env.work, env.runDir, 'p2').list('codex');
  const why = box.find((l) => l.from === 'head' && l.order === 'mul' && /범위 검사 FAIL/.test(l.body));
  assert.ok(why, '작성자(codex) 상자에 이유 편지');
  assert.match(why.body, /src\/add\.js: outside-allowed/);
  assert.match(why.body, /README\.md: outside-allowed/);

  await git(env.work, ['fetch', '--quiet', 'origin']);
  const integ = 'origin/trio/p2/integration';
  assert.equal(await showFile(env.work, integ, 'src/mul.js'), null, 'FAIL 조각은 integration에 없다');
  assert.equal(await showFile(env.work, integ, 'src/add.js'), (await import('./helpers.mjs')).CALC['src/add.js'], 'add는 원래 내용');
  const scope = readLedger(env.runDir).find((e) => e.action === 'scope' && e.piece === 'mul');
  assert.equal(scope.result, 'FAIL');
  // 범위 FAIL 조각은 검토로 가지 않는다
  assert.equal(readLedger(env.runDir).filter((e) => e.action === 'review-start' && e.piece === 'mul').length, 0);
});
