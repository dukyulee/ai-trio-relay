// P7: stop 뒤 가짜 에이전트 프로세스 0 · 상태 STOPPED · 웹 세션에 정지 메시지 · 다시 run 해도 자동 재개 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPlan, stopRun, StoppedError, approvePlan } from '../lib/run.mjs';
import { git } from '../lib/gitops.mjs';
import { readLedger, readSessions, recordSession } from '../lib/ledger.mjs';
import { loadState, isStopped } from '../lib/status.mjs';
import { isAlive, waitDead } from '../lib/adapters/common.mjs';
import { createClaudeWebAdapter, STOP_MESSAGE } from '../lib/adapters/claude-web.mjs';
import { setupRepo, calcPlan, mockAdapters, approved, waitFor } from './helpers.mjs';

const hang = async (ctx) => {
  await ctx.spawnChild();
  await ctx.waitAbort();
  return { state: 'failed', note: '정지됨' };
};

test('P7: trio stop → 프로세스 0개 · STOPPED · 정지 메시지 · 재실행 거부', async () => {
  const env = await setupRepo();
  await approved(env, calcPlan('p7'));
  const adapters = await mockAdapters(env, env.runDir, { claude: { author: hang }, codex: { author: hang }, antigravity: { author: hang } });
  const running = runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  running.catch(() => {});
  const pids = await waitFor(() => {
    const s = readSessions(env.runDir).filter((x) => x.kind === 'pid');
    return s.length === 3 ? s.map((x) => x.pid) : null;
  }, { timeout: 120000, what: '가짜 에이전트 프로세스 3개' });
  for (const pid of pids) assert.ok(isAlive(pid), `${pid}가 살아 있다(시험 전제)`);

  // 웹 세션도 하나 있다고 치고, 정지 메시지가 실제 명령으로 만들어지는지 본다(실행하지 않는 가짜 exec).
  recordSession(env.runDir, { piece: 'add', agent: 'claude', kind: 'claude-session', sessionId: 'session_0123456789' });
  const calls = [];
  const claudeWeb = createClaudeWebAdapter({ repoDir: env.work, runDir: env.runDir, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '{}' }; } });

  // 다른 프로세스의 `trio stop`과 같게: 실행 루프와 따로 정지 표시 + 기록된 프로세스 종료
  const res = await stopRun({ runDir: env.runDir, adapters: { claude: claudeWeb } });
  // stopRun이 죽였거나, 정지 표시를 본 실행 루프가 먼저 끝냈다(어느 쪽이든 0개가 목표). 「못 건드림」은 없어야 한다.
  assert.deepEqual(res.unknown.filter((u) => /PID/.test(u)), [], JSON.stringify(res));
  for (const pid of pids) assert.ok(await waitDead(pid), `${pid}가 남았다`);
  assert.deepEqual(calls, [['claude', '-p', STOP_MESSAGE, '--cloud', 'session_0123456789', '--output-format', 'json']]);

  const r = await running;
  assert.equal(r.status, 'STOPPED');
  assert.ok(isStopped(env.runDir));
  assert.equal(loadState(env.runDir).status, 'STOPPED');
  for (const st of Object.values(loadState(env.runDir).pieces)) assert.equal(st.state, 'STOPPED');
  const led = readLedger(env.runDir);
  assert.ok(led.some((e) => e.action === 'stop' && e.result === 'STOPPED'));
  assert.ok(led.some((e) => e.action === 'halt'));
  assert.equal(led.filter((e) => e.action === 'merge').length, 0, '정지 뒤 병합 없음');

  // integration은 base 그대로
  await git(env.work, ['fetch', '--quiet', 'origin']);
  const base = (await git(env.work, ['rev-parse', 'origin/trio/p7/base'])).trim();
  const integ = (await git(env.work, ['rev-parse', 'origin/trio/p7/integration'])).trim();
  assert.equal(integ, base);

  // 다시 run · approve 해도 자동 재개 안 됨
  const before = Object.values(adapters).reduce((n, a) => n + a.starts.length, 0);
  await assert.rejects(runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 }), StoppedError);
  assert.throws(() => approvePlan(env.runDir), StoppedError);
  const after = Object.values(adapters).reduce((n, a) => n + a.starts.length, 0);
  assert.equal(after, before, '어댑터 시작 0회');
  assert.ok(path.isAbsolute(env.runDir));
});

test('시작이 실패한 조각은 FAILED로 남고 실행은 멈추지 않는다(Codex 환경 ID 없음 · 실제 명령 실행 없음)', async () => {
  const { createCodexWebAdapter } = await import('../lib/adapters/codex-web.mjs');
  const env = await setupRepo();
  const plan = calcPlan('pf');
  plan.pieces = plan.pieces.filter((p) => p.id === 'mul');
  await approved(env, plan);
  const calls = [];
  const adapters = await mockAdapters(env, env.runDir);
  adapters.codex = createCodexWebAdapter({ repoDir: env.work, runDir: env.runDir, config: {}, exec: async (...a) => { calls.push(a); return { stdout: '' }; } });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.status, 'DONE');
  assert.equal(res.pieces.mul, 'FAILED');
  assert.match(loadState(env.runDir).pieces.mul.detail, /환경 ID/);
  assert.equal(calls.length, 0, 'codex 명령을 부르지 않았다');
});
