// 시험용 가짜 어댑터. 세 실제 어댑터와 같은 계약(start · poll · followUp · stop · capability)을 지킨다.
// 시나리오 함수를 주입받아, 자기 로컬 clone에서 실제 git 커밋 · 푸시를 한다(웹 VM 흉내).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git, pushWithRetry, hasStaged } from '../gitops.mjs';
import { Mailbox } from '../mailbox.mjs';
import { recordSession } from '../ledger.mjs';
import { killTree, processInfo } from './common.mjs';

// scenarios: { author(ctx) → {state, ...}, review(ctx) → {state, reviewText, changed} }
export function createMockAdapter({ name, originUrl, workRoot, runDir, scenarios = {}, canPushMailbox = true, reviewMode = 'output' }) {
  let seq = 0;
  const adapter = {
    name,
    capability: { canPushMailbox, canPushBranch: true, reviewMode, reviewToken: false },
    starts: [],
    followUps: [],
    stops: 0,

    async start({ run, order, branch, prompt, mode = 'author', token = '' }) {
      const h = { agent: name, piece: order.id, mode, branch, run, order, attempt: 1, children: [], token };
      adapter.starts.push({ piece: order.id, mode, at: Date.now(), prompt });
      return launch(h, prompt, null);
    },

    async poll(h) {
      if (!h.settled) return { state: 'running' };
      if (h.error) return { state: 'failed', detail: h.error };
      const r = h.result || { state: 'done' };
      return { state: r.state || 'done', detail: { reviewText: r.reviewText, changed: !!r.changed, note: r.note } };
    },

    async followUp(h, message, { token } = {}) {
      adapter.followUps.push({ piece: h.piece, mode: h.mode, message });
      return launch({ ...h, attempt: h.attempt + 1, settled: false, result: null, error: null, token: token || h.token }, message, message);
    },

    async stop(h) {
      adapter.stops += 1;
      if (!h) return { stopped: false };
      h.abort.abort();
      for (const c of h.children) await killTree(c.pid);
      return { stopped: true };
    },
  };

  async function launch(h, prompt, message) {
    const abort = new AbortController();
    const dir = path.join(workRoot, `${name}-${h.piece}-${h.mode}-${++seq}`);
    const hh = { ...h, abort, dir, children: [], settled: false };
    const scenario = scenarios[h.mode];
    hh.promise = (async () => {
      await git(workRoot, ['clone', '--quiet', originUrl, dir]);
      await git(dir, ['checkout', '--quiet', '-B', h.branch, `origin/${h.branch}`]);
      const ctx = makeCtx(hh, prompt, message);
      return scenario ? scenario(ctx) : { state: 'done' };
    })().then((r) => { hh.result = r; hh.settled = true; }, (err) => { hh.error = String(err && err.message || err); hh.settled = true; });
    return hh;
  }

  function makeCtx(h, prompt, message) {
    const dir = h.dir;
    return {
      agent: name, run: h.run, order: h.order, branch: h.branch, prompt, message, attempt: h.attempt, dir, token: h.token,
      signal: h.abort.signal,
      git: (args) => git(dir, args),
      write(rel, content) {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      },
      remove(rel) { fs.rmSync(path.join(dir, rel), { recursive: true, force: true }); },
      async commitPush(msg = `mock ${name}: ${h.piece}`) {
        await git(dir, ['add', '-A']);
        if (await hasStaged(dir)) await git(dir, ['commit', '--quiet', '-m', msg]);
        await pushWithRetry(dir, h.branch);
      },
      mailbox: canPushMailbox ? new Mailbox({ repoDir: dir, run: h.run, worktreeDir: `${dir}-mbox` }) : null,
      // 오래 도는 자식 프로세스(에이전트 프로세스 흉내). stop하면 끝나야 한다.
      async spawnChild() {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
        h.children.push(child);
        recordSession(runDir, { piece: h.piece, agent: name, kind: 'pid', mode: h.mode, pid: child.pid, info: await processInfo(child.pid) });
        return child;
      },
      waitAbort() {
        return new Promise((resolve) => {
          if (h.abort.signal.aborted) return resolve();
          h.abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  }

  return adapter;
}
