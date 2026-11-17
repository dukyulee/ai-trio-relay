// A1(2026-11-11): agy가 꺼져 있으면(capability.disabled) 검토 돌려 막기에서 건너뛴다 — Codex 조각은 Claude가 검토한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan } from '../lib/run.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { setupRepo, calcPlan, mockAdapters, approved } from './helpers.mjs';

test('A1: agy가 꺼져 있으면 Codex 조각의 검토자는 Claude이고, 꺼진 agy는 한 번도 불리지 않는다', async () => {
  const env = await setupRepo();
  const plan = calcPlan('off1');
  plan.pieces = plan.pieces.filter((p) => p.agent !== 'antigravity');
  assert.deepEqual(plan.pieces.map((p) => p.agent).sort(), ['claude', 'codex']);
  await approved(env, plan);
  const adapters = await mockAdapters(env, env.runDir);
  // 꺼진 agy 자리: 불리면 실패해야 한다(bin/trio.mjs disabledAgyAdapter와 같은 모양)
  let agyCalls = 0;
  const fail = async () => { agyCalls++; throw new Error('꺼진 agy가 불렸다'); };
  adapters.antigravity = { name: 'antigravity', capability: { canPushMailbox: false, disabled: true }, start: fail, startReview: fail, poll: fail, followUp: fail, stop: async () => {} };

  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50 });
  assert.equal(res.status, 'DONE');
  assert.deepEqual(res.pieces, { add: 'MERGED', mul: 'MERGED' });
  const reviews = readLedger(env.runDir).filter((e) => e.action === 'review');
  assert.deepEqual(reviews.map((r) => `${r.piece}:${r.agent}`).sort(), ['add:codex', 'mul:claude'], '막혀야 하는 쪽: mul을 agy에게 맡기지 않는다');
  assert.equal(agyCalls, 0);
});
