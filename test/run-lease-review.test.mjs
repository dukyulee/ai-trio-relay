// P5 임대 요청 → 승인 → 통과 / 승인 없이 → 거부, P6 검토 fail-closed(실행 단위).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan, makeHeadMailbox } from '../lib/run.mjs';
import { git, showFile } from '../lib/gitops.mjs';
import { readLedger, readJson } from '../lib/ledger.mjs';
import { setupRepo, calcPlan, mockAdapters, implement, approved, waitFor, CALC } from './helpers.mjs';
import path from 'node:path';

function onePiece(run) {
  const plan = calcPlan(run);
  plan.pieces = [plan.pieces[0]]; // add · claude
  return plan;
}

// add 조각이 src/format.js를 빌려 쓴다(아무 조각에도 없는 파일).
function leaseScenario({ ask = true, waitReply = true } = {}) {
  return async (ctx) => {
    if (ask) {
      const req = await ctx.mailbox.send({ from: 'claude', to: 'head', type: 'lease-request', needs_reply: true, order: 'add', body: '표시 함수가 필요하다.\npath: src/format.js' });
      if (waitReply) {
        await waitFor(async () => (await ctx.mailbox.list('claude')).find((l) => l.re === req.name), { timeout: 60000, interval: 100, what: '임대 답' });
      }
    }
    ctx.write('src/format.js', CALC['src/format.js'].replace(/import \{ mul \}.*\n/, '').replace(/export const formatProduct.*\n/, ''));
    return implement()(ctx);
  };
}

test('P5: 임대 요청 → HEAD 승인 → 그 파일 수정이 통과한다', async () => {
  const env = await setupRepo();
  await approved(env, onePiece('p5a'));
  const asked = [];
  const adapters = await mockAdapters(env, env.runDir, { claude: { author: leaseScenario() } });
  const res = await runPlan({
    repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50,
    decideLease: async ({ paths, order }) => { asked.push({ paths, id: order.id }); return true; },
  });
  assert.deepEqual(asked, [{ paths: ['src/format.js'], id: 'add' }]);
  assert.equal(res.pieces.add, 'MERGED', JSON.stringify(readLedger(env.runDir).filter((e) => e.action === 'scope')));
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.ok(await showFile(env.work, 'origin/trio/p5a/integration', 'src/format.js'));
  const branchOrder = JSON.parse(await showFile(env.work, 'origin/trio/p5a/add', '.trio/orders/add.json'));
  assert.ok(branchOrder.allowed_paths.includes('src/format.js'));
  assert.equal(branchOrder.leases.length, 1);
  const head = makeHeadMailbox(env.work, env.runDir, 'p5a');
  assert.ok((await head.readDecisions()).some((d) => d.includes('임대 승인') && d.includes('src/format.js')));
  assert.ok((await head.list('claude')).some((l) => l.type === 'lease-grant'));
  assert.ok(readJson(path.join(env.runDir, 'orders', 'add.json')).allowed_paths.includes('src/format.js'));
});

test('P5: 임대가 거부됐는데 고치면 / 묻지 않고 고치면 / ORDER를 스스로 늘리면 → 범위 FAIL', async () => {
  const env = await setupRepo();
  const plan = calcPlan('p5b');
  plan.pieces = plan.pieces.filter((p) => p.id !== 'format');
  await approved(env, plan);
  const adapters = await mockAdapters(env, env.runDir, {
    claude: { author: leaseScenario({ ask: true }) },
    codex: {
      author: async (ctx) => {
        // ORDER 파일을 스스로 고쳐 범위를 넓히고, 남의 파일을 고친다
        const f = '.trio/orders/mul.json';
        const o = JSON.parse(await showFile(ctx.dir, 'HEAD', f));
        o.allowed_paths.push('src/format.js');
        ctx.write(f, `${JSON.stringify(o, null, 2)}\n`);
        return implement({ 'src/format.js': '// 빼앗음\n' })(ctx);
      },
    },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50, decideLease: async () => false });
  assert.equal(res.pieces.add, 'SCOPE_FAILED');
  assert.equal(res.pieces.mul, 'SCOPE_FAILED');
  const scope = readLedger(env.runDir).filter((e) => e.action === 'scope');
  const add = scope.find((e) => e.piece === 'add');
  assert.deepEqual(add.violations, [{ path: 'src/format.js', rule: 'outside-allowed' }]);
  const mul = scope.find((e) => e.piece === 'mul');
  assert.ok(mul.violations.some((v) => v.path === '.trio/orders/mul.json' && v.rule === 'protected'));
  assert.ok(mul.violations.some((v) => v.path === 'src/format.js'));
  const head = makeHeadMailbox(env.work, env.runDir, 'p5b');
  assert.ok((await head.list('claude')).some((l) => l.type === 'answer' && /임대 거부/.test(l.body)));
});

test('P6 · M12: 검토 응답이 계속 깨지면(검토자 탓) 작성자는 건드리지 않고 검토만 다시 하다 사람에게, 검토자가 코드를 섞으면 즉시 사람에게', async () => {
  const env = await setupRepo();
  const plan = calcPlan('p6');
  plan.pieces = plan.pieces.filter((p) => p.id !== 'format');
  await approved(env, plan);
  const replies = ['', '{"verdict":"PASS","findings":[', 'PASS 입니다'];
  let i = 0;
  const adapters = await mockAdapters(env, env.runDir, {
    // add(claude)의 검토자는 codex: 응답 없음 → 깨진 JSON → 글
    codex: { review: async () => ({ state: 'done', reviewText: replies[i++] }) },
    // mul(codex)의 검토자는 antigravity: PASS라 말하면서 조각 브랜치에 커밋을 섞는다
    antigravity: {
      review: async (ctx) => {
        ctx.write('src/mul.js', '// 검토자가 고침\n');
        await ctx.commitPush('검토자가 몰래 고침');
        return { state: 'done', reviewText: '{"verdict":"PASS","findings":[]}' };
      },
    },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.pieces.add, 'NEEDS_HUMAN');
  assert.equal(res.pieces.mul, 'NEEDS_HUMAN');
  const reviews = readLedger(env.runDir).filter((e) => e.action === 'review');
  assert.deepEqual(reviews.filter((r) => r.piece === 'add').map((r) => r.reason), ['no-response', 'broken-json', 'broken-json']);
  assert.deepEqual(reviews.filter((r) => r.piece === 'mul').map((r) => r.reason), ['review-modified-code']);
  for (const r of reviews) assert.notEqual(r.agent, r.piece === 'add' ? 'claude' : 'codex', '검토자 ≠ 작성자');
  assert.equal(adapters.claude.followUps.length, 0, '검토자 탓 실패는 작성자에게 후속을 보내지 않는다');
  assert.equal(adapters.codex.starts.filter((s) => s.mode === 'review').length, 3, '검토만 3번(처음 + 다시 2번)');
  assert.ok(readLedger(env.runDir).some((e) => e.action === 'escalate' && e.piece === 'add' && e.reason === 'reviewer-fault'));
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.equal(await showFile(env.work, 'origin/trio/p6/integration', 'src/add.js'), null);
  assert.equal(await showFile(env.work, 'origin/trio/p6/integration', 'src/mul.js'), null);
  const recs = readJson(path.join(env.runDir, 'reviews', 'add.json'));
  assert.equal(recs.length, 3);
  assert.ok(recs.every((r) => r.verdict === 'FAIL' && r.reviewer === 'codex'));
});
