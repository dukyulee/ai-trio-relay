// 실행 단위: B1 검토 PASS 뒤 푸시 → CHANGED_AFTER_REVIEW, B2 HEAD 기록 없는 원격 base 거부, H4 실행 폴더 변조 → ABORTED, M14 오래된 PID.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPlan, stopRun } from '../lib/run.mjs';
import { git, showFile } from '../lib/gitops.mjs';
import { readLedger, recordSession, readJson } from '../lib/ledger.mjs';
import { loadState } from '../lib/status.mjs';
import { isAlive, killTree, waitDead, processInfo } from '../lib/adapters/common.mjs';
import { setupRepo, calcPlan, mockAdapters, implement, approved, waitFor, PASS_REVIEW, tempDir } from './helpers.mjs';

test('B1: 검토자가 PASS를 낸 뒤 조각 브랜치에 푸시하면 병합 줄이 CHANGED_AFTER_REVIEW로 거부한다', async () => {
  const env = await setupRepo();
  const plan = calcPlan('gb');
  plan.pieces = plan.pieces.filter((p) => p.id !== 'format');
  await approved(env, plan);
  let sneaked;
  const sneakDone = new Promise((r) => { sneaked = r; });
  const adapters = await mockAdapters(env, env.runDir, {
    codex: {
      // mul(codex 작성): 몰래 푸시가 끝날 때까지 기다렸다 끝낸다(병합 줄이 그 뒤에 돌게)
      author: async (ctx) => { await sneakDone; return implement()(ctx); },
      // add(claude)의 검토자 codex: PASS를 내고, HEAD가 PASS로 기록한 뒤에 조각 브랜치에 몰래 푸시한다
      review: async (ctx) => {
        (async () => {
          await waitFor(() => (loadState(env.runDir).pieces.add || {}).state === 'PASSED', { timeout: 120000, what: 'add PASSED' });
          ctx.write('src/add.js', 'export const add = () => 42;\n');
          await ctx.commitPush('검토 뒤 몰래');
          sneaked();
        })().catch(sneaked);
        return { state: 'done', reviewText: PASS_REVIEW };
      },
    },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.pieces.add, 'CHANGED_AFTER_REVIEW', JSON.stringify(res));
  assert.equal(res.pieces.mul, 'MERGED');
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.equal(await showFile(env.work, 'origin/trio/gb/integration', 'src/add.js'), null, '몰래 바뀐 조각은 합치지 않는다');
});

test('B2: 원격에 HEAD 기록 없는 trio/<실행>/base가 이미 있으면 실행하지 않는다', async () => {
  const env = await setupRepo();
  await approved(env, calcPlan('gx'));
  await git(env.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/trio/gx/base']);
  const adapters = await mockAdapters(env, env.runDir);
  await assert.rejects(runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 }), /HEAD가 만든 기록이 없다/);
  assert.equal(Object.values(adapters).reduce((n, a) => n + a.starts.length, 0), 0, '에이전트를 시작하지 않았다');
});

test('H4: 실행 중에 실행 폴더의 ORDER가 HEAD 모르게 바뀌면 ABORTED로 멈추고 합치지 않는다', async () => {
  const env = await setupRepo();
  const plan = calcPlan('gh');
  plan.pieces = plan.pieces.filter((p) => p.id === 'add');
  await approved(env, plan);
  const adapters = await mockAdapters(env, env.runDir, {
    claude: {
      author: async (ctx) => {
        // 샌드박스를 벗어난 에이전트가 실행 폴더의 ORDER를 넓힌다고 치자
        const f = path.join(env.runDir, 'orders', 'add.json');
        const o = readJson(f);
        o.allowed_paths.push('**');
        fs.writeFileSync(f, JSON.stringify(o, null, 2));
        return implement({ 'src/mul.js': '// 남의 파일\n' })(ctx);
      },
    },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.status, 'ABORTED');
  assert.match(res.detail, /orders\/add\.json가 바뀌었다/);
  assert.ok(readLedger(env.runDir).some((e) => e.action === 'halt' && e.result === 'ABORTED'));
  assert.equal(readLedger(env.runDir).filter((e) => e.action === 'merge').length, 0);
  assert.equal(loadState(env.runDir).status, 'ABORTED');
});

test('M14: trio stop은 기록과 시작 시각 · 이름이 다른 PID(재사용)를 죽이지 않는다', async () => {
  const runDir = tempDir();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const info = await processInfo(child.pid);
    recordSession(runDir, { piece: 'add', agent: 'antigravity', kind: 'pid', pid: child.pid, info: { ...info, start: '2001-01-01T00:00:00.0000000Z' } });
    recordSession(runDir, { piece: 'mul', agent: 'antigravity', kind: 'pid', pid: child.pid });
    const r = await stopRun({ runDir });
    assert.deepEqual(r.killed, []);
    assert.equal(r.unknown.length, 2);
    assert.ok(isAlive(child.pid), '다른 프로세스일 수 있는 PID는 그대로');
    recordSession(runDir, { piece: 'format', agent: 'antigravity', kind: 'pid', pid: child.pid, info });
    const r2 = await stopRun({ runDir });
    assert.deepEqual(r2.killed, [child.pid]);
    assert.ok(await waitDead(child.pid));
  } finally {
    await killTree(child.pid);
  }
});
