// 실행 단위 M5: 중계형(Codex) 에이전트의 임대 — outbox로 낸 요청을 HEAD가 바로 판단하고, 승인 편지를 다음 작업 지시문으로 전한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan, makeHeadMailbox } from '../lib/run.mjs';
import { git, showFile } from '../lib/gitops.mjs';
import { formatLetter } from '../lib/mailbox.mjs';
import { setupRepo, calcPlan, mockAdapters, implement, approved, CALC } from './helpers.mjs';

test('M5: 중계형 임대 요청 → 승인 → lease-grant가 후속 작업으로 전해지고 → 빌린 파일 수정이 통과한다', async () => {
  const env = await setupRepo();
  const plan = calcPlan('rl');
  plan.pieces = plan.pieces.filter((p) => p.id === 'mul'); // codex · 중계형
  await approved(env, plan);
  const prompts = [];
  const adapters = await mockAdapters(env, env.runDir, {
    codex: {
      canPushMailbox: false,
      author: async (ctx) => {
        prompts.push(ctx.message || ctx.prompt);
        if (ctx.attempt === 1) {
          // 첫 작업: 자기 파일만 쓰고, src/format.js를 빌려 달라는 편지를 outbox로 낸다
          ctx.write('.trio/outbox/1.md', formatLetter({ from: 'codex', to: 'head', type: 'lease-request', re: '', needs_reply: true, order: 'mul', body: '표시 함수가 필요하다.\npath: src/format.js' }));
          return implement()(ctx);
        }
        // 후속 작업: 지시문에 lease-grant가 있을 때만 빌린 파일을 고친다
        if (!/type="lease-grant"/.test(ctx.message)) return { state: 'done' };
        ctx.write('src/format.js', "import { PRECISION } from './types.js';\nimport { mul } from './mul.js';\nexport const formatProduct = (a, b) => mul(a, b).toFixed(PRECISION);\n");
        await ctx.commitPush('빌린 파일');
        return { state: 'done' };
      },
    },
  });
  const res = await runPlan({ repoDir: env.work, runDir: env.runDir, adapters, pollMs: 50, decideLease: async ({ paths }) => paths.join(',') === 'src/format.js' });
  assert.equal(res.pieces.mul, 'MERGED', JSON.stringify(res));
  assert.equal(adapters.codex.followUps.length, 1);
  assert.match(prompts[1], /<mail trust="peer"[^>]*type="lease-grant"/);
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.ok(await showFile(env.work, 'origin/trio/rl/integration', 'src/format.js'));
  assert.equal(await showFile(env.work, 'origin/trio/rl/integration', 'src/mul.js'), CALC['src/mul.js']);
  const dec = await makeHeadMailbox(env.work, env.runDir, 'rl').readDecisions();
  assert.ok(dec.some((d) => d.includes('임대 승인') && d.includes('src/format.js')));
});
