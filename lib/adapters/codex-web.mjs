// Codex 웹 어댑터: `codex cloud exec --env <환경> --branch <조각> "<지시>"` · `codex cloud status <id>` · `codex cloud diff <id>`.
// Codex 작업은 전달함에 직접 못 쓴다(중계). 결과 diff를 조각 브랜치에 적용하는 일은 HEAD가 collect()로 한다 —
// 적용한 결과를 먼저 범위 검사하고, 통과했을 때만 GitHub에 푸시한다(.github 등이 Actions에서 비밀값으로 돌지 않게).
// 출력 형식은 착수 때 확인 대상이다(X1 · X2) — 작업 ID를 못 찾으면 원문을 저장하고 'failed', 상태 글은 낱말로 짐작하지 않는다.
import path from 'node:path';
import { run as runCmd, git, ensureWorktree, fetchBranch, withRepoLock, revParse } from '../gitops.mjs';
import { recordSession, saveRaw } from '../ledger.mjs';
import { outboxFilesFromPatch, nonOutboxPathsFromPatch } from '../relay.mjs';
import { parseLetter } from '../mailbox.mjs';
import { assertSafeArgs, assertSafeExtraArgs, stripEcho } from './common.mjs';

// 확인 전에는 모르는 상태 글을 'unknown'으로 두고, 이만큼 이어지면 FAILED(형식 미확인).
export const DEFAULT_MAX_UNKNOWN_POLLS = 240;

export function buildExecCommand({ envId, branch, prompt, extraArgs = [] }) {
  if (!envId) throw new Error('Codex 환경 ID가 없다 — `trio init --codex-env <ID>`로 .trio/config.json에 넣는다');
  assertSafeExtraArgs(extraArgs);
  return { cmd: 'codex', args: assertSafeArgs(['cloud', 'exec', '--env', envId, '--branch', branch, ...extraArgs, prompt], { free: [prompt] }) };
}

export function buildStatusCommand(taskId) {
  return { cmd: 'codex', args: assertSafeArgs(['cloud', 'status', taskId]) };
}

export function buildDiffCommand(taskId) {
  return { cmd: 'codex', args: assertSafeArgs(['cloud', 'diff', taskId]) };
}

export function parseTask(stdout, prompt = '') {
  const s = stripEcho(stdout, prompt);
  const url = s.match(/https:\/\/chatgpt\.com\/codex\/tasks\/([A-Za-z0-9_-]+)/);
  if (url) return { taskId: url[1], link: url[0] };
  const id = s.match(/\b(task_[A-Za-z0-9_-]{6,})\b/);
  if (id) return { taskId: id[1], link: null };
  return null;
}

// status 출력 분류. 형식이 확인되기 전(X2)에는 낱말로 짐작하지 않는다 — 「not completed yet」도 끝이 아니다.
// 확인한 뒤 .trio/config.json의 codex.status = {"done": "<정규식>", "failed": "…", "limit": "…"}로 켠다.
export function classifyStatus(text, patterns = null) {
  if (!patterns) return 'unknown';
  const s = String(text || '');
  for (const st of ['limit', 'failed', 'done']) {
    if (patterns[st] && new RegExp(patterns[st], 'm').test(s)) return st;
  }
  return 'unknown';
}

// checkScope(worktreeDir) → {ok, violations}: run이 넘겨준다. 통과해야 푸시한다.
export function createCodexWebAdapter({ repoDir, runDir, workRoot, config = {}, exec = runCmd }) {
  const cfg = config.codex || {};
  const extraArgs = cfg.extraArgs || [];
  const root = workRoot || path.join(runDir, 'worktrees'); // HEAD 전용(Codex는 클라우드에서 돈다)
  const maxUnknown = cfg.maxUnknownPolls ?? DEFAULT_MAX_UNKNOWN_POLLS;

  async function startTask(order, branch, prompt, mode, token) {
    const { cmd, args } = buildExecCommand({ envId: cfg.envId, branch, prompt, extraArgs });
    const startedAt = new Date().toISOString();
    const base = { agent: 'codex', piece: order.id, branch, mode, startedAt, order, token, unknownPolls: 0 };
    let out;
    try {
      out = await exec(cmd, args, { cwd: repoDir });
    } catch (err) {
      saveRaw(runDir, `codex-exec-${order.id}`, `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`);
      return { ...base, failed: `codex cloud exec 실패: ${err.message}` };
    }
    const t = parseTask(out.stdout, prompt);
    if (!t) {
      const f = saveRaw(runDir, `codex-exec-${order.id}`, `${out.stdout}\n${out.stderr || ''}`);
      return { ...base, failed: `작업 ID를 찾지 못했다(원문: ${path.basename(f)})` };
    }
    recordSession(runDir, { piece: order.id, agent: 'codex', kind: 'codex-task', mode, taskId: t.taskId, link: t.link });
    return { ...base, ...t };
  }

  async function diff(h) {
    const { cmd, args } = buildDiffCommand(h.taskId);
    return (await exec(cmd, args, { cwd: repoDir })).stdout;
  }

  return {
    name: 'codex',
    capability: { canPushMailbox: false, canPushBranch: false, reviewMode: 'outbox', reviewToken: false },

    start({ order, branch, prompt, mode = 'author', token = '' }) {
      return startTask(order, branch, prompt, mode, token);
    },

    async poll(h) {
      if (h.failed) return { state: 'failed', detail: h.failed };
      const { cmd, args } = buildStatusCommand(h.taskId);
      let out;
      try {
        out = await exec(cmd, args, { cwd: repoDir });
      } catch (err) {
        saveRaw(runDir, `codex-status-${h.piece}`, `${err.stdout || ''}${err.stderr || ''}`);
        return { state: 'failed', detail: 'codex cloud status 실패(원문은 실행 폴더 logs/)' };
      }
      const state = classifyStatus(out.stdout, cfg.status || null);
      if (state === 'unknown') {
        h.unknownPolls = (h.unknownPolls || 0) + 1;
        if (h.unknownPolls >= maxUnknown) {
          saveRaw(runDir, `codex-status-${h.piece}`, out.stdout);
          return { state: 'failed', detail: `상태 형식을 모른다(${h.unknownPolls}회) — docs/verified.md X2 확인 뒤 codex.status 설정` };
        }
        return { state: 'running' };
      }
      if (state !== 'done' || h.mode !== 'review') return { state, detail: '' };
      // 검토: diff에는 .trio/outbox/review.md 편지 하나만 있어야 한다. 다른 파일(또는 해석 못 한 머리말)이 있으면 코드 섞임.
      const patch = await diff(h);
      const changed = nonOutboxPathsFromPatch(patch).length > 0;
      let reviewText = null;
      for (const f of outboxFilesFromPatch(patch)) {
        try {
          const l = parseLetter(f.content);
          if (l.type === 'review' && l.from === 'codex') reviewText = l.body;
        } catch { /* 깨진 편지는 검토 응답 없음으로 본다 */ }
      }
      return { state: 'done', detail: { reviewText, changed } };
    },

    // 작성 결과 diff를 조각 worktree에 적용 · 커밋하고, 범위 검사를 통과하면 푸시한다. 같은 작업은 두 번 적용하지 않는다.
    async collect(h, { checkScope } = {}) {
      if (h.collected) return h.collected;
      const patch = await diff(h);
      const wt = path.join(root, `codex-${h.piece}-collect`);
      await withRepoLock(repoDir, async () => {
        await fetchBranch(repoDir, h.branch);
        await ensureWorktree(repoDir, wt, `refs/remotes/origin/${h.branch}`);
      });
      const before = await revParse(wt, 'HEAD');
      if (patch.trim()) {
        await git(wt, ['apply', '--index', '--whitespace=nowarn', '-'], { input: patch });
        await git(wt, ['commit', '--quiet', '--allow-empty', '-m', `trio: codex 결과(${h.piece})`]);
      }
      const head = await revParse(wt, 'HEAD');
      if (head === before) {
        h.collected = { applied: false, pushed: false };
        return h.collected;
      }
      if (checkScope) {
        const scope = await checkScope(wt);
        if (!scope.ok) {
          h.collected = { applied: true, pushed: false, scope };
          return h.collected;
        }
      }
      await withRepoLock(repoDir, () => git(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${h.branch}`]));
      h.collected = { applied: true, pushed: true, sha: head };
      return h.collected;
    },

    async followUp(h, message, { token } = {}) {
      return startTask(h.order, h.branch, message, h.mode, token || h.token);
    },

    async stop() {
      return { stopped: false, note: 'Codex 웹 작업 취소 방법은 착수 때 확인(docs/verified.md) — 실행 상태 STOPPED로 결과를 쓰지 않는다' };
    },
  };
}
