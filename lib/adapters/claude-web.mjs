// Claude Code 웹 어댑터: `claude --cloud "<지시>"`로 웹 세션을 만들고, `claude -p <메시지> --cloud <세션> --output-format json`으로 후속을 보낸다.
// 출력 형식 · 상태 확인 · 정지 방법은 착수 때 확인 대상이다(docs/verified.md). 세션 ID를 찾지 못하면 추측하지 않고 'failed'.
//
// 기본은 중계형이다(canPushMailbox: false — C1 확인 전). 이때
//   작성 끝 = 조각 브랜치의 `.trio/outbox/done.md`에 `trio-done <토큰>`
//   검토 결과 = 검토 브랜치 `trio/<실행>/review-<조각>-<토큰>`의 `.trio/outbox/review.md` 하나
// 직접형(설정 claude.canPushMailbox: true)이면 작성 끝 = 하트비트(토큰 일치), 검토 = head 상자의 review 편지(시각 · 토큰 일치).
import path from 'node:path';
import { run as runCmd, git, fetchBranch, withRepoLock, revParse } from '../gitops.mjs';
import { recordSession, saveRaw } from '../ledger.mjs';
import { letterTime, parseLetter } from '../mailbox.mjs';
import { assertSafeArgs, assertSafeExtraArgs, stripEcho } from './common.mjs';

export const STOP_MESSAGE = 'trio STOP: 실행이 정지됐다. 지금 하던 일을 멈추고, 더 커밋 · 푸시하지 말고 끝낸다.';
const REVIEW_FILE = '.trio/outbox/review.md';
const DONE_FILE = '.trio/outbox/done.md';

export function buildStartCommand(prompt, { extraArgs = [] } = {}) {
  assertSafeExtraArgs(extraArgs);
  return { cmd: 'claude', args: assertSafeArgs(['--cloud', ...extraArgs, prompt], { free: [prompt] }) };
}

export function buildFollowUpCommand(sessionId, message, { extraArgs = [] } = {}) {
  assertSafeExtraArgs(extraArgs);
  return { cmd: 'claude', args: assertSafeArgs(['-p', message, '--cloud', sessionId, '--output-format', 'json', ...extraArgs], { free: [message] }) };
}

// 출력에서 세션 ID를 찾는다. 우리가 넣은 지시문 · 인용 칸에 든 ID 모양 글은 빼고 본다.
export function parseSession(stdout, prompt = '') {
  const s = stripEcho(stdout, prompt);
  const url = s.match(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+)/);
  if (url) return { sessionId: url[1], link: url[0] };
  const id = s.match(/\b(session_[A-Za-z0-9_-]{8,})\b/);
  if (id) return { sessionId: id[1], link: null };
  return null;
}

export function reviewBranchName(run, piece, token) {
  return `trio/${run}/review-${piece}-${token}`;
}

export function createClaudeWebAdapter({ repoDir, runDir, workRoot, config = {}, exec = runCmd, mailbox }) {
  const cfg = config.claude || {};
  const extraArgs = cfg.extraArgs || [];
  const direct = cfg.canPushMailbox === true;
  // 로컬 worktree는 `claude --cloud`를 부를 자리일 뿐이다(에이전트는 클라우드에서 돈다) — HEAD 전용으로 실행 폴더 안에 둔다.
  const root = workRoot || path.join(runDir, 'worktrees');
  const worktreeFor = (id, mode) => path.join(root, `claude-${id}-${mode}`);

  async function send(sessionId, message) {
    const { cmd, args } = buildFollowUpCommand(sessionId, message, { extraArgs });
    return exec(cmd, args, { cwd: repoDir });
  }

  async function readBranchFile(branch, file) {
    const ok = await withRepoLock(repoDir, () => fetchBranch(repoDir, branch));
    if (!ok) return null;
    return git(repoDir, ['show', `refs/remotes/origin/${branch}:${file}`], { allowFail: true });
  }

  return {
    name: 'claude',
    capability: { canPushMailbox: direct, canPushBranch: true, reviewMode: direct ? 'mailbox' : 'branch', reviewToken: true },

    async start({ run, order, branch, prompt, mode = 'author', token = '', pieceSha = null }) {
      const wt = worktreeFor(order.id, mode);
      await withRepoLock(repoDir, async () => {
        await fetchBranch(repoDir, branch);
        await git(repoDir, ['worktree', 'prune']);
        await git(repoDir, ['worktree', 'add', '--quiet', '-B', branch, wt, `refs/remotes/origin/${branch}`], { allowFail: true });
      });
      const { cmd, args } = buildStartCommand(prompt, { extraArgs });
      const startedAt = new Date().toISOString();
      const base = { agent: 'claude', piece: order.id, run: run || order.run, branch, mode, startedAt, token, pieceSha };
      let out;
      try {
        out = await exec(cmd, args, { cwd: wt });
      } catch (err) {
        saveRaw(runDir, `claude-start-${order.id}`, `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`);
        return { ...base, failed: `claude --cloud 실패: ${err.message}` };
      }
      const s = parseSession(out.stdout, prompt);
      if (!s) {
        const f = saveRaw(runDir, `claude-start-${order.id}`, `${out.stdout}\n${out.stderr || ''}`);
        return { ...base, failed: `세션 ID를 찾지 못했다(원문: ${path.basename(f)})` };
      }
      recordSession(runDir, { piece: order.id, agent: 'claude', kind: 'claude-session', mode, sessionId: s.sessionId, link: s.link });
      return { ...base, ...s };
    },

    async poll(h) {
      if (h.failed) return { state: 'failed', detail: h.failed };
      if (h.mode === 'review') return direct ? pollReviewMailbox(h) : pollReviewBranch(h);
      if (direct) {
        // 하트비트는 토큰으로 이번 작업 것인지 본다(에이전트 시계는 믿지 않는다).
        const hb = (await mailbox.readHeartbeats()).claude;
        if (hb && hb.order === h.piece && hb.token === h.token) {
          if (hb.state === 'done') return { state: 'done' };
          if (hb.state === 'limit') return { state: 'limit', detail: hb.note || '' };
          if (hb.state === 'failed') return { state: 'failed', detail: hb.note || '' };
        }
        return { state: 'running' };
      }
      const done = await readBranchFile(h.branch, DONE_FILE);
      return done !== null && done.includes(`trio-done ${h.token}`) ? { state: 'done' } : { state: 'running' };
    },

    async followUp(h, message, { token } = {}) {
      if (h.failed) return h;
      await send(h.sessionId, message);
      return { ...h, token: token || h.token, startedAt: new Date().toISOString() };
    },

    async stop(h) {
      if (!h || !h.sessionId) return { stopped: false };
      await send(h.sessionId, STOP_MESSAGE);
      return { stopped: true, note: '정지 메시지를 보냈다(웹 세션 강제 종료 방법은 착수 때 확인)' };
    },

    stopSession(sessionId) {
      return send(sessionId, STOP_MESSAGE);
    },
  };

  // 직접형 검토: head 상자의 review 편지 중 이번 회차(시작 시각 이후 이름 · 토큰 일치)만 받는다.
  async function pollReviewMailbox(h) {
    const since = Date.parse(h.startedAt);
    const letters = await mailbox.peek('head');
    const mine = letters.find((l) => !l.broken && l.from === 'claude' && l.type === 'review' && l.order === h.piece
      && letterTime(l.name) >= since && String(l.body).includes(h.token));
    if (!mine) return { state: 'running' };
    await mailbox.markRead('head', [mine.name]);
    return { state: 'done', detail: { reviewText: mine.body, changed: false } };
  }

  // 중계형 검토: 검토 브랜치에는 검토한 커밋 위에 review.md 하나만 더해져 있어야 한다. 다른 변경이 있으면 코드 섞임.
  async function pollReviewBranch(h) {
    const rb = reviewBranchName(h.run, h.piece, h.token);
    const ok = await withRepoLock(repoDir, () => fetchBranch(repoDir, rb));
    if (!ok) return { state: 'running' };
    const tip = await revParse(repoDir, `refs/remotes/origin/${rb}`);
    const raw = h.pieceSha ? await git(repoDir, ['diff', '--name-only', '-z', h.pieceSha, tip], { allowFail: true }) : null;
    const files = raw === null ? null : raw.split('\0').filter(Boolean);
    const changed = !files || files.length !== 1 || files[0] !== REVIEW_FILE;
    let reviewText = null;
    const text = await git(repoDir, ['show', `${tip}:${REVIEW_FILE}`], { allowFail: true });
    if (text !== null) {
      try {
        const l = parseLetter(text);
        if (l.from === 'claude' && l.type === 'review' && l.order === h.piece) reviewText = l.body;
      } catch { /* 깨진 편지 = 응답 없음 */ }
    }
    return { state: 'done', detail: { reviewText, changed } };
  }
}
