// 오케스트레이션: 승인 확인 → base(계약 + ORDER) → 조각 브랜치 → 동시 시작 → 폴링 → (결과 반영 · 범위 선검사) → 중계 → 범위 → 검토 → 병합 줄.
// 정지(STOPPED) 표시가 보이면 어느 단계든 바로 멈춘다. 실행 폴더의 계획 · ORDER · 상태가 HEAD 모르게 바뀌면 중단한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, fetchBranch, remoteBranchSha, commitToBranch, withRepoLock, sleep, revParse } from './gitops.mjs';
import { Mailbox } from './mailbox.mjs';
import { validatePlan, buildOrder, orderJson, orderPath, branchNames, planHash, topoOrder, grantLease, parseLeasePaths, ID_RE } from './orders.mjs';
import { checkScope, OUTBOX_PREFIX } from './scope.mjs';
import { relayBranch } from './relay.mjs';
import { pickReviewer, parseReview, formatFindings, MAX_REREVIEWS, REVIEWER_FAULTS } from './review.mjs';
import { mergeQueue } from './mergeq.mjs';
import { buildAuthorPrompt, buildReviewerPrompt, buildFollowUpPrompt } from './prompt.mjs';
import { appendLedger, ensureRunDir, readJson, writeJson, readSessions, setControlWriteListener } from './ledger.mjs';
import { loadState, saveState, isStopped, markStopped } from './status.mjs';
import { killTree, processInfo, sameProcess, isAlive, waitDead } from './adapters/common.mjs';
import { reviewBranchName } from './adapters/claude-web.mjs';
import { withFileLock } from './lock.mjs';

export class StoppedError extends Error {
  constructor() {
    super('이 실행은 정지(STOPPED)됐다 — 자동으로 다시 시작하지 않는다. 새 실행 이름으로 계획을 다시 올린다.');
    this.name = 'StoppedError';
  }
}

export class IntegrityError extends Error {
  constructor(msg) {
    super(`무결성 검사 실패 — 실행을 중단한다: ${msg}`);
    this.name = 'IntegrityError';
  }
}

const planFile = (runDir) => path.join(runDir, 'plan.json');
const orderFile = (runDir, id) => path.join(runDir, 'orders', `${id}.json`);
const approvalsFile = (runDir) => path.join(runDir, 'lease-approvals.jsonl');
export const runLockFile = (runDir) => path.join(runDir, 'locks', 'run.lock');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fileHash = (f) => (fs.existsSync(f) ? sha256(fs.readFileSync(f)) : null);
const newToken = () => crypto.randomBytes(4).toString('hex');

// `trio plan`: 검증하고 승인 대기 상태로 둔다. 승인 전에는 아무 에이전트도 시작하지 않는다.
export function preparePlan({ runDir, plan, run, maxPieces }) {
  const v = validatePlan(plan, { maxPieces });
  if (!v.ok) return v;
  if (isStopped(runDir)) return { ok: false, errors: ['이 실행 이름은 이미 정지됐다 — 다른 이름을 쓴다'] };
  ensureRunDir(runDir);
  writeJson(planFile(runDir), plan);
  saveState(runDir, { run, status: 'PLANNED', planHash: planHash(plan), approved: null, pieces: {} });
  return { ok: true, errors: [], hash: planHash(plan) };
}

// `trio approve`: 지금 plan.json 내용(해시)에 승인 표시를 붙인다. 계획을 고치면 승인이 풀린다.
export function approvePlan(runDir, { by = 'human' } = {}) {
  const state = loadState(runDir);
  const plan = readJson(planFile(runDir));
  if (!state || !plan) throw new Error('계획이 없다 — 먼저 `trio plan --file plan.json`');
  if (state.status === 'STOPPED') throw new StoppedError();
  const hash = planHash(plan);
  state.approved = { hash, by, at: new Date().toISOString() };
  state.status = 'APPROVED';
  saveState(runDir, state);
  return state;
}

function loadApproved(runDir) {
  if (isStopped(runDir)) throw new StoppedError();
  const state = loadState(runDir);
  const plan = readJson(planFile(runDir));
  if (!state || !plan) throw new Error('계획이 없다 — 먼저 `trio plan`');
  if (!state.approved || state.approved.hash !== planHash(plan)) throw new Error('계획 승인이 없다(또는 승인 뒤 계획이 바뀌었다) — `trio approve`');
  const v = validatePlan(plan, { maxPieces: Infinity });
  if (!v.ok) throw new Error(`계획이 바르지 않다: ${v.errors.join(' / ')}`);
  return { state, plan };
}

export function makeHeadMailbox(repoDir, runDir, run) {
  return new Mailbox({ repoDir, run, worktreeDir: path.join(runDir, 'worktrees', 'mailbox'), stateDir: runDir, redactPaths: [runDir] });
}

function loadOrders(runDir, plan, run) {
  const orders = {};
  for (const p of plan.pieces) {
    const f = orderFile(runDir, p.id);
    orders[p.id] = readJson(f) || buildOrder(plan, p, run);
    writeJson(f, orders[p.id]);
  }
  return orders;
}

// 실행 폴더 무결성: 제어 파일은 이 실행 루프(이 프로세스)만 바꾼다. 디스크 값이 HEAD가 마지막으로 쓴 해시와 다르면 중단한다.
// 지키는 것: plan.json · orders/*.json · state.json · sessions.json · mailbox-own.json(감사 제외 SHA · 격리) · decisions.jsonl · relayed.json.
// lease-approvals.jsonl은 다른 프로세스(`trio lease`)가 쓰므로 「앞부분이 그대로이고 뒤에만 붙는지」만 본다.
const keyOf = (f) => path.resolve(f).toLowerCase();
export function makeGuard(runDir, orderIds) {
  const files = [
    planFile(runDir), path.join(runDir, 'state.json'), path.join(runDir, 'sessions.json'),
    path.join(runDir, 'mailbox-own.json'), path.join(runDir, 'decisions.jsonl'), path.join(runDir, 'relayed.json'),
    ...orderIds.map((id) => orderFile(runDir, id)),
  ];
  const expect = new Map(files.map((f) => [keyOf(f), { file: f, hash: fileHash(f) }]));
  const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  let approvals = readText(approvalsFile(runDir));
  return {
    // 이 프로세스가 제어 파일을 썼다(ledger.writeJson · Mailbox가 알린다).
    touch(file) {
      const e = expect.get(keyOf(file));
      if (e) e.hash = fileHash(e.file);
    },
    saveOrder(order) {
      writeJson(orderFile(runDir, order.id), order);
    },
    saveState(state) {
      saveState(runDir, state);
    },
    check() {
      for (const { file, hash } of expect.values()) {
        if (fileHash(file) !== hash) throw new IntegrityError(`${path.relative(runDir, file).replace(/\\/g, '/')}가 바뀌었다`);
      }
      const now = readText(approvalsFile(runDir));
      if (!now.startsWith(approvals)) throw new IntegrityError('lease-approvals.jsonl의 앞부분이 바뀌었다(추가만 된다)');
      approvals = now;
    },
  };
}

// base 브랜치: 계약 파일 + ORDER 파일을 HEAD만 커밋한다. 모든 조각 · integration이 이 커밋에서 시작한다.
// 원격에 HEAD 기록에 없는 base · 조각 브랜치가 이미 있으면 믿지 않고 거부한다. 기록과 다르면 중단한다.
async function prepareBranches({ repoDir, runDir, plan, run, orders, mailbox, state, persist }) {
  const names = branchNames(run);
  const contract = plan.contract || {};
  const from = plan.base || 'main';
  if ((await git(repoDir, ['check-ref-format', '--branch', from], { allowFail: true })) === null) throw new Error(`base 브랜치 이름 "${from}"이 바르지 않다`);
  const remoteBase = await remoteBranchSha(repoDir, names.base);
  if (state.baseSha) {
    if (remoteBase !== state.baseSha) throw new IntegrityError(`원격 ${names.base}(${String(remoteBase).slice(0, 12)})가 HEAD가 만든 ${state.baseSha.slice(0, 12)}와 다르다`);
  } else {
    if (remoteBase) throw new Error(`원격에 이미 ${names.base}가 있는데 HEAD가 만든 기록이 없다 — 믿지 않는다. 다른 실행 이름을 쓴다`);
    const ok = await withRepoLock(repoDir, () => fetchBranch(repoDir, from));
    if (!ok) throw new Error(`원격에 base 브랜치 ${from}이 없다`);
    const res = await commitToBranch({
      repoDir, worktreeDir: path.join(runDir, 'worktrees', 'head'), branch: names.base,
      createFrom: `refs/remotes/origin/${from}`,
      message: `trio: 계약 + ORDER (${run})`,
      wantSha: true,
      apply: async (wt) => {
        for (const [p, c] of Object.entries(contract.files || {})) {
          fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
          fs.writeFileSync(path.join(wt, p), c);
        }
        for (const p of contract.paths || []) {
          if (!/[*?]/.test(p) && !fs.existsSync(path.join(wt, p))) throw new Error(`계약 파일 ${p}가 없다`);
        }
        for (const o of Object.values(orders)) {
          const f = path.join(wt, orderPath(o.id));
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, orderJson(o));
        }
      },
    });
    if ((await remoteBranchSha(repoDir, names.base)) !== res.sha) throw new IntegrityError('base를 푸시한 직후 원격 값이 다르다');
    state.baseSha = res.sha;
    state.createdBranches = [];
    persist();
    await mailbox.appendDecision(`계약 고정 ${res.sha.slice(0, 12)} — 계약 파일: ${(contract.paths || []).join(', ') || '없음'}`);
  }
  state.createdBranches = state.createdBranches || [];
  for (const b of [...Object.values(orders).map((o) => o.branch), names.integration]) {
    if (state.createdBranches.includes(b)) continue;
    if (await remoteBranchSha(repoDir, b)) throw new Error(`원격에 이미 ${b}가 있는데 HEAD가 만든 기록이 없다 — 믿지 않는다`);
    await withRepoLock(repoDir, () => git(repoDir, ['push', '--quiet', 'origin', `${state.baseSha}:refs/heads/${b}`]));
    state.createdBranches.push(b);
    persist();
  }
  if (!state.integrationSha) {
    state.integrationSha = state.baseSha;
    persist();
  }
  await withRepoLock(repoDir, () => fetchBranch(repoDir, names.base));
  return { names };
}

function mailMode(adapter) {
  return adapter.capability.canPushMailbox ? 'direct' : 'relay';
}

// 중계형 에이전트에게 줄 읽지 않은 편지. 지시문에 넣는 순간 HEAD가 대신 읽음 기록을 남긴다.
async function lettersForRelay(mailbox, agent) {
  const letters = (await mailbox.peek(agent)).filter((l) => !l.broken);
  if (letters.length) await mailbox.markRead(agent, letters.map((l) => l.name));
  return letters;
}

// `trio lease`가 남긴 HEAD 판단(다른 프로세스). 편지 이름 → {decision, paths}
export function readLeaseApprovals(runDir) {
  const f = approvalsFile(runDir);
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.letter === 'string') out[e.letter] = e;
    } catch { /* 깨진 줄은 무시 */ }
  }
  return out;
}

export function recordLeaseApproval(runDir, { letter, decision, paths = [] }) {
  if (!['grant', 'deny'].includes(decision)) throw new Error('decision은 grant | deny');
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(approvalsFile(runDir), `${JSON.stringify({ letter, decision, paths, at: new Date().toISOString() })}\n`);
}

export async function runPlan(opts) {
  const { runDir } = opts;
  if (isStopped(runDir)) throw new StoppedError();
  fs.mkdirSync(path.join(runDir, 'locks'), { recursive: true });
  // 한 실행에는 루프 하나. 같은 실행을 두 번 돌리지 않는다.
  return withFileLock(runLockFile(runDir), () => runPlanLocked(opts), { timeoutMs: 1000 });
}

async function runPlanLocked(opts) {
  const { repoDir, runDir, adapters, pollMs = 2000, timeoutMs = 6 * 3600 * 1000, decideLease = null, maxMailFollowUps = 2, onEvent = () => {} } = opts;
  const { state, plan } = loadApproved(runDir);
  const run = state.run;
  const mailbox = opts.mailbox || makeHeadMailbox(repoDir, runDir, run);
  const orders = loadOrders(runDir, plan, run);
  const contractPaths = (plan.contract && plan.contract.paths) || [];
  const log = (entry) => { appendLedger(runDir, entry); onEvent(entry); };
  const guard = makeGuard(runDir, Object.keys(orders));
  setControlWriteListener((f) => guard.touch(f));
  try {
    return await runLoop();
  } finally {
    setControlWriteListener(null);
  }

  async function runLoop() {
  const persist = () => guard.saveState(state);
  const pieceOf = Object.fromEntries(plan.pieces.map((p) => [p.agent, p.id]));
  const decide = decideLease || (async ({ letter }) => {
    const a = readLeaseApprovals(runDir)[letter.name];
    return a ? a.decision === 'grant' : null;
  });

  for (const p of plan.pieces) {
    if (!adapters[p.agent]) throw new Error(`에이전트 ${p.agent} 어댑터가 없다`);
    const r = pickReviewer(p.agent);
    if (!adapters[r]) throw new Error(`검토자 ${r} 어댑터가 없다`);
  }
  const directAgents = [...new Set(Object.values(adapters).filter((a) => a.capability.canPushMailbox).map((a) => a.name))];

  await mailbox.init();
  if (isStopped(runDir)) throw new StoppedError();
  if (!state.mailboxAuditedSha) {
    state.mailboxAuditedSha = (await mailbox.audit({ since: null })).tip;
    persist();
  }
  // 실행 루프는 감사한 커밋까지만 읽는다(감사와 읽기 사이에 들어온 위조 편지를 보지 않게).
  mailbox.auditedTip = state.mailboxAuditedSha;
  mailbox.readAtAudited = true;
  await prepareBranches({ repoDir, runDir, plan, run, orders, mailbox, state, persist });

  state.status = 'RUNNING';
  for (const p of plan.pieces) {
    state.pieces[p.id] = { agent: p.agent, branch: orders[p.id].branch, reviewer: pickReviewer(p.agent), state: 'STARTING', reviews: 0, reviewRetries: 0, mailFollowUps: 0, decisionsSeen: 0 };
  }
  persist();
  const setPiece = (id, patch) => {
    state.pieces[id] = { ...state.pieces[id], ...patch, lastSignal: new Date().toISOString() };
    persist();
  };
  const newDecisions = (id) => {
    const all = mailbox.readLocalDecisions();
    const seen = state.pieces[id].decisionsSeen || 0;
    state.pieces[id].decisionsSeen = all.length;
    return all.slice(seen);
  };

  const entries = {};
  // 지시문을 먼저 다 만든 뒤(중계형 편지 포함) 한꺼번에 시작한다.
  const prompts = {};
  const delivered = {};
  for (const p of plan.pieces) {
    const ad = adapters[p.agent];
    const mode = mailMode(ad);
    const letters = mode === 'relay' ? await lettersForRelay(mailbox, p.agent) : [];
    delivered[p.id] = letters.length;
    const token = newToken();
    prompts[p.id] = { token, text: buildAuthorPrompt({ order: orders[p.id], contractPaths, letters, decisions: newDecisions(p.id), mode, canPushBranch: ad.capability.canPushBranch, token }) };
  }
  persist();
  if (isStopped(runDir)) throw new StoppedError();
  await Promise.all(plan.pieces.map(async (p) => {
    const adapter = adapters[p.agent];
    const order = orders[p.id];
    const { token, text } = prompts[p.id];
    const t0 = Date.now();
    let h;
    try {
      h = await adapter.start({ run, order, branch: order.branch, prompt: text, mode: 'author', token });
    } catch (err) {
      h = { failed: `시작 실패: ${err.message}` };
    }
    const startedAt = new Date().toISOString();
    entries[p.id] = { phase: 'author', agent: p.agent, h, token };
    log({ agent: p.agent, piece: p.id, action: 'start', result: h.failed ? 'failed' : 'ok', ms: Date.now() - t0, startedAt, delivered: delivered[p.id], detail: h.failed });
    setPiece(p.id, h.failed ? { state: 'FAILED', startedAt, detail: h.failed } : { state: 'RUNNING', startedAt, link: h.link || null });
  }));

  const active = new Set(plan.pieces.filter((p) => !entries[p.id].h.failed).map((p) => p.id));
  const passed = new Set();
  let tampered = null; // 전달함 변조 이유(있으면 다음 확인 지점에서 실행 전체를 멈춘다)
  const deadline = Date.now() + timeoutMs;

  // pieceState: 멈출 때 조각에 붙일 상태(기본은 실행 상태와 같다). 전달함 변조면 모든 조각을 사람에게(NEEDS_HUMAN).
  const halt = async (status = 'STOPPED', why = '', { pieceState = status, all = false } = {}) => {
    for (const id of active) {
      const e = entries[id];
      const ad = adapters[e.phase === 'review' ? e.reviewer : e.agent];
      try { await ad.stop(e.h); } catch { /* 이미 끝났을 수 있다 */ }
      state.pieces[id].state = pieceState;
    }
    if (all) for (const id of Object.keys(state.pieces)) state.pieces[id].state = pieceState;
    active.clear();
    passed.clear();
    state.status = status;
    try { persist(); } catch { /* 상태 파일 자체가 문제일 수 있다 */ }
    log({ agent: 'head', piece: '*', action: 'halt', result: status, detail: why });
    return { status, pieces: pieceStates(state), detail: why };
  };

  // 무결성 · 정지 확인. 실패하면 halt 결과를 돌려준다(없으면 null).
  const checkpoint = async () => {
    if (isStopped(runDir)) return halt('STOPPED');
    if (tampered) return halt('MAILBOX_TAMPERED', tampered, { pieceState: 'NEEDS_HUMAN', all: true });
    try {
      guard.check();
    } catch (err) {
      if (isStopped(runDir)) return halt('STOPPED'); // `trio stop`이 상태를 쓴 경우
      return halt('ABORTED', err.message);
    }
    return null;
  };

  const notifyAuthor = (id, body, type = 'review') => mailbox.send({ from: 'head', to: orders[id].agent, type, order: id, needs_reply: false, body: body.slice(0, 4000) });

  const escalate = async (id, reason, detail = '') => {
    const e = entries[id];
    if (active.has(id)) {
      active.delete(id);
      const ad = adapters[e.phase === 'review' ? e.reviewer : e.agent];
      try { await ad.stop(e.h); } catch { /* 무시 */ }
    }
    passed.delete(id);
    setPiece(id, { state: 'NEEDS_HUMAN', detail: `${reason}${detail ? `: ${detail}` : ''}`.slice(0, 500) });
    log({ agent: 'head', piece: id, action: 'escalate', result: 'NEEDS_HUMAN', reason, detail: String(detail).slice(0, 300) });
  };

  // 직접형 에이전트가 전달함에 쓴 것을 감사한다.
  // - 누가 했는지 알면(같은 커밋에 그 에이전트의 자기 편지가 있다) 그 에이전트 조각을 사람에게.
  // - 누가 했는지 모르는 위반 · 역사 고침 · 감사 자체의 실패는 실행 전체를 멈춘다(MAILBOX_TAMPERED). 기준(mailboxAuditedSha)은 옮기지 않는다.
  async function auditMailbox() {
    if (tampered) throw new Error(`전달함 변조로 멈춤: ${tampered}`);
    let res;
    try {
      res = await mailbox.audit({ since: state.mailboxAuditedSha, directAgents });
    } catch (err) {
      tampered = `감사 실패: ${String(err.message).slice(0, 200)}`;
      log({ agent: 'head', piece: '*', action: 'mailbox-audit', result: 'error', detail: tampered });
      throw err;
    }
    const { tip, violations, rewritten } = res;
    const unknown = violations.filter((v) => !v.actors || !v.actors.length);
    for (const v of violations) log({ agent: 'head', piece: '*', action: 'mailbox-audit', result: 'violation', rule: v.rule, path: v.path, actors: v.actors });
    if (rewritten || unknown.length) {
      tampered = `${unknown.map((v) => `${v.rule} ${v.path}`).join(' · ')}`.slice(0, 400) || 'history-rewritten';
      throw new Error(`전달함 변조: ${tampered}`);
    }
    if (tip && tip !== state.mailboxAuditedSha) {
      state.mailboxAuditedSha = tip;
      persist();
    }
    for (const v of violations) {
      for (const a of v.actors) {
        const id = pieceOf[a];
        if (id && state.pieces[id] && state.pieces[id].state !== 'NEEDS_HUMAN') await escalate(id, 'mailbox-violation', `${v.rule} ${v.path}`);
      }
    }
  }

  // head 상자는 늘 감사 뒤에만 읽는다(감사 전의 위조 편지를 처리하지 않게). 감사가 실패하면 이번 순번은 건너뛴다(예외를 그대로 올린다).
  async function handleHeadBox() {
    await auditMailbox();
    const letters = await mailbox.peek('head');
    const handled = [];
    for (const l of letters) {
      // 편지 하나의 문제가 루프 전체를 멈추지 않게 한 통씩 받는다. 실패한 편지는 처리됨으로 기록한다.
      try {
        if (l.broken) { handled.push(l.name); continue; }
        if (l.type !== 'lease-request') continue; // review 편지는 검토 흐름이, 나머지는 사람 · HEAD 스킬이 읽는다
        const order = orders[l.order];
        if (!ID_RE.test(l.order || '') || !order || order.agent !== l.from) {
          await mailbox.reply(l, { from: 'head', body: '임대 거부: 조각 또는 작성자가 맞지 않는다.' });
          handled.push(l.name);
          continue;
        }
        const paths = parseLeasePaths(l.body);
        const decision = await decide({ letter: l, order, paths });
        if (decision === null || decision === undefined) {
          if (state.pieces[l.order].lastLetter !== `임대 요청 대기 ${l.name}`) setPiece(l.order, { lastLetter: `임대 요청 대기 ${l.name}` });
          continue; // 판단 대기 — 읽음 처리하지 않는다
        }
        if (decision === true) {
          try {
            orders[order.id] = await applyLease({ repoDir, runDir, run, piece: order.id, paths, letter: l, mailbox, markLetterRead: false, saveOrder: guard.saveOrder });
            log({ agent: 'head', piece: order.id, action: 'lease-grant', result: 'ok', paths });
          } catch (err) {
            await mailbox.reply(l, { from: 'head', body: String(err.message).slice(0, 2000) });
            log({ agent: 'head', piece: order.id, action: 'lease-grant', result: 'refused', reason: err.message });
          }
        } else {
          await mailbox.reply(l, { from: 'head', body: `임대 거부: ${paths.join(', ')}` });
          log({ agent: 'head', piece: order.id, action: 'lease-grant', result: 'denied', paths });
        }
        handled.push(l.name);
      } catch (err) {
        handled.push(l.name);
        log({ agent: 'head', piece: l.order || '*', action: 'head-letter', result: 'error', letter: l.name, detail: String(err.message).slice(0, 300) });
      }
    }
    if (handled.length) await mailbox.markRead('head', handled);
    for (const w of mailbox.warnings.splice(0)) log({ agent: 'head', piece: '*', action: 'mailbox-warning', result: 'warn', detail: w });
  }

  // 조각 브랜치(또는 반영 전 worktree)의 범위 검사. HEAD 사본 ORDER와 고정 base SHA로만 본다.
  const scopeAt = (dir, head, id) => checkScope({
    repoDir: dir, base: state.baseSha, head, order: orders[id], contractPaths,
    headOrderJson: orderJson(orders[id]), orderFile: orderPath(id),
  });

  async function scopeFail(id, violations, note = '') {
    active.delete(id);
    const body = `범위 검사 FAIL — 이 조각은 합치지 않는다.${note ? ` (${note})` : ''}\n${violations.map((v) => `- ${v.path}: ${v.rule}`).join('\n')}`;
    await notifyAuthor(id, body);
    setPiece(id, { state: 'SCOPE_FAILED', detail: violations });
    log({ agent: 'head', piece: id, action: 'scope', result: 'FAIL', violations, note });
  }

  async function startReview(id) {
    const order = orders[id];
    const reviewer = pickReviewer(order.agent);
    const ad = adapters[reviewer];
    const tip = await remoteBranchSha(repoDir, order.branch);
    if (tip !== state.pieces[id].scopeSha) {
      active.delete(id);
      setPiece(id, { state: 'CHANGED_AFTER_SCOPE', detail: '범위 검사 뒤 조각 브랜치가 바뀌었다' });
      log({ agent: 'head', piece: id, action: 'review-start', result: 'CHANGED_AFTER_SCOPE' });
      return;
    }
    const token = newToken();
    const reviewMode = ad.capability.reviewMode;
    const prompt = buildReviewerPrompt({
      order, reviewer, reviewMode, token: ad.capability.reviewToken ? token : '',
      reviewBranch: reviewMode === 'branch' ? reviewBranchName(run, id, token) : '',
    });
    let h;
    try {
      h = await ad.start({ run, order, branch: order.branch, prompt, mode: 'review', token, pieceSha: state.pieces[id].scopeSha });
    } catch (err) {
      h = { failed: `검토 시작 실패: ${err.message}` };
    }
    entries[id] = { ...entries[id], phase: 'review', reviewer, h, reviewToken: token };
    log({ agent: reviewer, piece: id, action: 'review-start', result: h.failed ? 'failed' : 'ok' });
    setPiece(id, { state: 'REVIEWING' });
    if (h.failed) await reviewerFault(id, 'reviewer-failed', h.failed);
  }

  // 검토자 쪽 실패(한도 · 실패 · 응답 없음 · 형식 깨짐 · 토큰 어긋남)는 작성자 탓이 아니다. 검토만 다시 하고, 넘치면 사람에게.
  async function reviewerFault(id, reason, detail = '') {
    const retries = (state.pieces[id].reviewRetries || 0) + 1;
    setPiece(id, { reviewRetries: retries });
    log({ agent: entries[id].reviewer, piece: id, action: 'review-fault', result: reason, retries, detail: String(detail).slice(0, 300) });
    if (retries > MAX_REREVIEWS) return escalate(id, 'reviewer-fault', reason);
    return startReview(id);
  }

  async function onAuthorDone(id, r) {
    const e = entries[id];
    const order = orders[id];
    const ad = adapters[e.agent];
    if (r.state === 'limit' || r.state === 'failed') {
      active.delete(id);
      setPiece(id, { state: r.state === 'limit' ? 'LIMIT' : 'FAILED', detail: String(r.detail || '').slice(0, 500) });
      log({ agent: e.agent, piece: id, action: 'author-end', result: r.state, detail: String(r.detail || '').slice(0, 300) });
      return;
    }
    // HEAD가 대신 푸시하는 에이전트(Codex · agy): 반영한 결과를 먼저 범위 검사하고, 통과해야 GitHub에 올린다.
    if (ad.collect) {
      const c = await ad.collect(e.h, { checkScope: (wt) => scopeAt(wt, 'HEAD', id) });
      if (c.scope && !c.scope.ok) return scopeFail(id, c.scope.violations, '푸시하지 않았다');
    }
    if (isStopped(runDir)) return;
    const relayed = await relayBranch({
      repoDir, base: state.baseSha, branch: order.branch, agent: order.agent, order: id, mailbox, runDir,
      worktreeDir: path.join(runDir, 'worktrees', `relay-${id}`), isStopped: () => isStopped(runDir),
    });
    if (relayed.stopped || isStopped(runDir)) return;
    if (relayed.sent.length || relayed.rejected.length) log({ agent: 'head', piece: id, action: 'relay', result: 'ok', sent: relayed.sent.length, rejected: relayed.rejected.length });
    // 중계로 온 임대 요청은 지금 판단해야 승인 편지를 다음 작업으로 전할 수 있다.
    try { await handleHeadBox(); } catch (err) { log({ agent: 'head', piece: id, action: 'head-box', result: 'error', detail: String(err.message).slice(0, 300) }); }
    if (!active.has(id)) return; // 감사에서 사람에게 넘어갔다
    // 중계형은 작업 중간에 편지를 못 받는다. 전하지 못한 편지(답 요청 · 임대 승인 · blocker · fyi)가 있으면 다음 작업으로 전한다.
    if (mailMode(ad) === 'relay' && state.pieces[id].mailFollowUps < maxMailFollowUps) {
      // 방금 HEAD가 보낸 편지(lease-grant 등)까지 보이게 한 번 더 감사한다(HEAD 커밋은 바로 통과).
      await auditMailbox();
      if (!active.has(id)) return;
      const pending = (await mailbox.peek(order.agent)).filter((l) => !l.broken);
      if (pending.length) {
        await mailbox.markRead(order.agent, pending.map((l) => l.name));
        const token = newToken();
        const msg = buildFollowUpPrompt({ order, reason: '새 편지가 왔다. 필요하면 ORDER 범위 안에서 고치고, 답은 .trio/outbox 편지로 낸다.', letters: pending, decisions: newDecisions(id), canPushBranch: ad.capability.canPushBranch, mode: 'relay', token });
        e.h = await ad.followUp(e.h, msg, { token });
        e.token = token;
        setPiece(id, { state: 'RUNNING', mailFollowUps: state.pieces[id].mailFollowUps + 1, lastLetter: pending[pending.length - 1].name });
        log({ agent: e.agent, piece: id, action: 'mail-followup', result: 'ok', delivered: pending.length });
        return;
      }
    }
    await withRepoLock(repoDir, () => fetchBranch(repoDir, order.branch));
    const tip = await revParse(repoDir, `refs/remotes/origin/${order.branch}`);
    const scope = await scopeAt(repoDir, tip, id);
    // 아무것도 바꾸지 않은 조각은 통과가 아니다(한도 오류를 못 알아본 「끝남」 포함).
    const real = scope.changes.filter((c) => !c.path.startsWith(OUTBOX_PREFIX) && c.path !== orderPath(id));
    if (!real.length && scope.ok) {
      active.delete(id);
      await notifyAuthor(id, '바뀐 파일이 없다(NO_CHANGES) — 이 조각은 합치지 않는다.');
      setPiece(id, { state: 'NO_CHANGES' });
      log({ agent: 'head', piece: id, action: 'scope', result: 'NO_CHANGES' });
      return;
    }
    if (!scope.ok) return scopeFail(id, scope.violations);
    log({ agent: 'head', piece: id, action: 'scope', result: 'PASS', files: scope.files, lines: scope.lines, sha: tip });
    setPiece(id, { scopeSha: tip });
    await startReview(id);
  }

  async function onReviewDone(id, r) {
    const e = entries[id];
    const order = orders[id];
    const ad = adapters[e.reviewer];
    if (r.state === 'limit' || r.state === 'failed') return reviewerFault(id, `reviewer-${r.state}`, r.detail);
    const shaAfter = await remoteBranchSha(repoDir, order.branch);
    const changed = !!(r.detail && r.detail.changed) || shaAfter !== state.pieces[id].scopeSha;
    const text = r.detail ? r.detail.reviewText : null;
    const result = parseReview(text, { codeChanged: changed, expectedToken: ad.capability.reviewToken ? e.reviewToken : null });
    const rounds = state.pieces[id].reviews + 1;
    saveReviewRecord(runDir, id, { round: rounds, reviewer: e.reviewer, author: order.agent, sha: state.pieces[id].scopeSha, ...result });
    setPiece(id, { reviews: rounds });
    log({ agent: e.reviewer, piece: id, action: 'review', result: result.verdict, reason: result.reason, round: rounds });
    await notifyAuthor(id, `검토(${e.reviewer}) ${rounds}회차\n${formatFindings(result)}`);
    if (result.verdict === 'PASS') {
      active.delete(id);
      passed.add(id);
      // 병합 줄은 이 커밋만 합친다(그 뒤 누가 푸시했으면 CHANGED_AFTER_REVIEW).
      setPiece(id, { state: 'PASSED', passedSha: state.pieces[id].scopeSha });
      return;
    }
    // 검토자가 코드를 바꿨으면 브랜치를 믿을 수 없다 → 사람에게.
    if (result.reason === 'review-modified-code') return escalate(id, 'review-modified-code');
    if (REVIEWER_FAULTS.includes(result.reason)) return reviewerFault(id, result.reason);
    // 검토자가 FAIL로 판정했다 → 작성자가 고친다. 고치기 · 재검토는 최대 MAX_REREVIEWS번.
    const fixes = (state.pieces[id].fixes || 0) + 1;
    if (fixes > MAX_REREVIEWS) return escalate(id, 'review-fail-limit', result.reason);
    const author = adapters[order.agent];
    if (mailMode(author) === 'relay') await auditMailbox(); // 방금 보낸 검토 편지까지 보이게
    const letters = mailMode(author) === 'relay' ? await lettersForRelay(mailbox, order.agent) : [];
    const token = newToken();
    const msg = buildFollowUpPrompt({ order, reason: `교차 검토 FAIL(${result.reason}). 지적을 고친다.`, findings: formatFindings(result), letters, decisions: newDecisions(id), canPushBranch: author.capability.canPushBranch, mode: mailMode(author), token });
    entries[id] = { phase: 'author', agent: order.agent, h: await author.followUp(e.authorH, msg, { token }), token };
    setPiece(id, { state: 'RUNNING', fixes });
    log({ agent: order.agent, piece: id, action: 'fix-followup', result: 'ok', round: rounds });
  }

  while (active.size) {
    const cp = await checkpoint();
    if (cp) return cp;
    try { await handleHeadBox(); } catch (err) { log({ agent: 'head', piece: '*', action: 'head-box', result: 'error', detail: String(err.message).slice(0, 300) }); }
    for (const id of [...active]) {
      const cp2 = await checkpoint();
      if (cp2) return cp2;
      if (!active.has(id)) continue; // 이번 순번에 감사 등으로 빠진 조각
      const e = entries[id];
      const ad = adapters[e.phase === 'review' ? e.reviewer : e.agent];
      // 한 조각의 오류가 실행 전체를 멈추지 않게 조각 단위로 받는다(그 조각은 FAILED — fail-closed).
      try {
        const r = await ad.poll(e.h);
        e.pollErrors = 0;
        if (r.state === 'running') continue;
        if (e.phase === 'author') {
          e.authorH = e.h;
          await onAuthorDone(id, r);
        } else {
          await onReviewDone(id, r);
        }
      } catch (err) {
        e.pollErrors = (e.pollErrors || 0) + 1;
        log({ agent: 'head', piece: id, action: 'error', result: 'retry', phase: e.phase, detail: String(err.message).slice(0, 300) });
        if (e.pollErrors >= 3) {
          active.delete(id);
          try { await ad.stop(e.h); } catch { /* 무시 */ }
          setPiece(id, { state: 'FAILED', detail: String(err.message).slice(0, 500) });
        }
      }
    }
    if (Date.now() > deadline) {
      for (const id of active) {
        const e = entries[id];
        try { await adapters[e.phase === 'review' ? e.reviewer : e.agent].stop(e.h); } catch { /* 무시 */ }
        setPiece(id, { state: 'FAILED', detail: 'timeout' });
      }
      active.clear();
      log({ agent: 'head', piece: '*', action: 'timeout', result: 'FAILED' });
      break;
    }
    if (active.size) await sleep(pollMs);
  }
  // 마지막 감사(끝난 뒤 들어온 위반도 병합 전에 본다)
  try { await auditMailbox(); } catch (err) { log({ agent: 'head', piece: '*', action: 'mailbox-audit', result: 'error', detail: String(err.message).slice(0, 300) }); }
  const cp = await checkpoint();
  if (cp) return cp;

  const ordered = topoOrder(plan.pieces).filter((p) => passed.has(p.id))
    .map((p) => ({ ...p, branch: orders[p.id].branch, passedSha: state.pieces[p.id].passedSha }));
  const { results: merges } = await mergeQueue({
    repoDir, run, pieces: ordered, verify: plan.verify, baseSha: state.baseSha, integrationSha: state.integrationSha,
    worktreeDir: path.join(runDir, 'worktrees', 'integration'),
    isStopped: () => isStopped(runDir),
    notify: (p, st, body) => notifyAuthor(p.id, `병합 줄 ${st}\n${body}`),
    onIntegration: (sha) => { state.integrationSha = sha; persist(); },
  });
  for (const m of merges) {
    setPiece(m.id, { state: m.state });
    log({ agent: 'head', piece: m.id, action: 'merge', result: m.state });
  }
  const cp3 = await checkpoint();
  if (cp3) return cp3;
  state.status = 'DONE';
  persist();
  log({ agent: 'head', piece: '*', action: 'run-end', result: 'DONE' });
  return { status: 'DONE', pieces: pieceStates(state), merges };
  }
}

function pieceStates(state) {
  return Object.fromEntries(Object.entries(state.pieces).map(([id, p]) => [id, p.state]));
}

// `trio stop`: 정지 표시 → 로컬 프로세스 트리 종료 → 웹 세션에 정지 메시지. 다른 프로세스에서 불러도 된다.
// PID는 기록한 시작 시각 · 실행 파일 이름이 지금과 같을 때만 끝낸다(그새 다른 프로세스가 같은 번호를 받았을 수 있다).
export async function stopRun({ runDir, adapters = {}, reason = 'trio stop' }) {
  markStopped(runDir, reason);
  const out = { killed: [], messaged: [], unknown: [] };
  for (const s of readSessions(runDir)) {
    if (s.kind === 'pid') {
      if (!isAlive(s.pid)) continue; // 이미 끝났다
      const now = await processInfo(s.pid);
      if (!now && await waitDead(s.pid, 3000)) continue; // 확인하는 사이에 끝났다(실행 루프가 먼저 끝낸 경우)
      if (!now) {
        out.unknown.push(`${s.piece}: PID ${s.pid}가 살아 있지만 시작 시각을 읽지 못해 건드리지 않았다 — 직접 확인한다`);
        continue;
      }
      if (!s.info || !sameProcess(now, s.info)) {
        out.unknown.push(`${s.piece}: PID ${s.pid}의 시작 시각 · 이름이 기록과 달라(또는 기록이 없어) 건드리지 않았다`);
        continue;
      }
      if (await killTree(s.pid)) out.killed.push(s.pid);
    } else if (s.kind === 'claude-session' && adapters.claude && adapters.claude.stopSession) {
      try {
        await adapters.claude.stopSession(s.sessionId);
        out.messaged.push(s.piece);
      } catch (err) {
        out.unknown.push(`${s.piece}: 정지 메시지 실패 ${err.message}`);
      }
    } else if (s.kind === 'codex-task') {
      out.unknown.push(`${s.piece}: Codex 작업 취소 방법 미확인 — 결과는 쓰지 않는다`);
    }
  }
  const state = loadState(runDir);
  if (state) saveState(runDir, { ...state, status: 'STOPPED' });
  appendLedger(runDir, { agent: 'head', piece: '*', action: 'stop', result: 'STOPPED', killed: out.killed.length, messaged: out.messaged.length });
  return out;
}

function saveReviewRecord(runDir, id, rec) {
  const f = path.join(runDir, 'reviews', `${id}.json`);
  writeJson(f, [...readJson(f, []), { at: new Date().toISOString(), ...rec }]);
}

// 임대 승인(HEAD 판단): HEAD 사본 ORDER를 늘리고, 조각 브랜치의 ORDER 파일에 커밋하고, 결정 게시판에 적고, 승인 편지를 보낸다.
// 실행 루프 안에서만 부른다(saveOrder로 무결성 기록을 함께 바꾼다). 다른 프로세스는 recordLeaseApproval로 판단만 남긴다.
export async function applyLease({ repoDir, runDir, run, piece, paths, letter = null, mailbox, markLetterRead = true, saveOrder }) {
  if (isStopped(runDir)) throw new StoppedError();
  const order = readJson(orderFile(runDir, piece));
  if (!order) throw new Error(`조각 ${piece}의 ORDER가 없다`);
  if (letter && (letter.from !== order.agent || letter.order !== piece)) throw new Error('임대 요청 편지의 보낸이 · 조각이 ORDER와 맞지 않는다');
  const next = grantLease(order, paths, { reason: letter ? letter.body.slice(0, 200) : '', letter: letter ? letter.name : null });
  const json = orderJson(next);
  await commitToBranch({
    repoDir, worktreeDir: path.join(runDir, 'worktrees', `head-${piece}`), branch: order.branch,
    message: `trio: 임대 승인 ${paths.join(', ')}`,
    apply: async (wt) => {
      const f = path.join(wt, orderPath(piece));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, json);
    },
  });
  (saveOrder || ((o) => writeJson(orderFile(runDir, o.id), o)))(next);
  await mailbox.appendDecision(`임대 승인: ${piece}(${order.agent}) ← ${paths.join(', ')}${letter ? ` (편지 ${letter.name})` : ''}`);
  const body = `승인: ${paths.join(', ')}\n조각 브랜치의 ORDER가 바뀌었다. git pull --rebase 뒤 고친다.`;
  if (letter) {
    await mailbox.reply(letter, { from: 'head', type: 'lease-grant', body });
    if (markLetterRead) await mailbox.markRead('head', [letter.name]);
  } else {
    await mailbox.send({ from: 'head', to: order.agent, type: 'lease-grant', order: piece, needs_reply: false, body });
  }
  appendLedger(runDir, { agent: 'head', piece, action: 'lease-grant', result: 'ok', paths, run });
  return next;
}

// 실행 루프가 돌고 있지 않을 때만 상태를 바꾸는 명령(`trio merge` · `trio review --file`)을 허용한다.
// 실행 루프가 쓰는 제어 파일을 다른 프로세스가 바꾸면 루프가 무결성 검사로 멈추므로, 그런 명령은 루프가 없을 때만 한다.
export async function whenIdle(runDir, fn) {
  let entered = false;
  try {
    return await withFileLock(runLockFile(runDir), () => { entered = true; return fn(); }, { timeoutMs: 500 });
  } catch (err) {
    if (!entered && /잠금을/.test(err.message)) throw new Error('`trio run`이 이 실행을 돌리고 있다 — 끝난 뒤 다시 한다(임대 판단은 trio lease, 정지는 trio stop)');
    throw err;
  }
}

// `trio merge`: 상태가 PASSED인 조각을 의존 순서대로 병합 줄에 넣는다(검토를 통과한 커밋만).
export function mergePassed({ repoDir, runDir, run, mailbox }) {
  return whenIdle(runDir, async () => {
    const { state, plan } = loadApproved(runDir);
    const passed = topoOrder(plan.pieces).filter((p) => state.pieces[p.id] && state.pieces[p.id].state === 'PASSED')
      .map((p) => ({ ...p, branch: state.pieces[p.id].branch, passedSha: state.pieces[p.id].passedSha }));
    const { results: merges } = await mergeQueue({
      repoDir, run, pieces: passed, verify: plan.verify, baseSha: state.baseSha, integrationSha: state.integrationSha,
      worktreeDir: path.join(runDir, 'worktrees', 'integration'),
      isStopped: () => isStopped(runDir),
      notify: (p, st, body) => mailbox.send({ from: 'head', to: p.agent, type: 'review', order: p.id, needs_reply: false, body: `병합 줄 ${st}\n${body}`.slice(0, 4000) }),
      onIntegration: (sha) => { state.integrationSha = sha; saveState(runDir, state); },
    });
    for (const m of merges) {
      state.pieces[m.id] = { ...state.pieces[m.id], state: m.state };
      appendLedger(runDir, { agent: 'head', piece: m.id, action: 'merge', result: m.state });
    }
    saveState(runDir, state);
    return merges;
  });
}

// `trio review --file`: 다른 경로로 받은 검토 결과를 넣는다. 형식이 깨지면 FAIL(fail-closed).
// 범위 검사를 통과해 검토 단계까지 간 조각에만 쓴다(범위 FAIL · 변경 없음 · 브랜치 바뀜 조각은 안 된다).
export const REVIEWABLE = ['REVIEWING', 'REVIEW_FAILED', 'NEEDS_HUMAN'];
export function recordReview({ repoDir, runDir, piece, text, mailbox }) {
  if (!ID_RE.test(piece || '')) return Promise.reject(new Error(`조각 이름 "${piece}" 형식이 바르지 않다`));
  return whenIdle(runDir, async () => {
    const { state } = loadApproved(runDir);
    const p = state.pieces[piece];
    if (!p) throw new Error(`조각 ${piece}가 실행 상태에 없다`);
    if (!REVIEWABLE.includes(p.state) || !p.scopeSha) throw new Error(`조각 ${piece}는 ${p.state} 상태라 검토 결과를 넣을 수 없다(범위 검사를 통과한 조각만)`);
    if (repoDir) {
      const tip = await remoteBranchSha(repoDir, p.branch);
      if (tip !== p.scopeSha) throw new Error(`조각 ${piece} 브랜치가 범위 검사 뒤 바뀌었다 — 검토 결과를 넣지 않는다`);
    }
    const result = parseReview(text);
    const round = (p.reviews || 0) + 1;
    saveReviewRecord(runDir, piece, { round, reviewer: p.reviewer, author: p.agent, manual: true, sha: p.scopeSha, ...result });
    await mailbox.send({ from: 'head', to: p.agent, type: 'review', order: piece, needs_reply: false, body: `검토(${p.reviewer}) ${round}회차\n${formatFindings(result)}`.slice(0, 4000) });
    state.pieces[piece] = { ...p, state: result.verdict === 'PASS' ? 'PASSED' : 'REVIEW_FAILED', reviews: round, passedSha: result.verdict === 'PASS' ? p.scopeSha : null };
    saveState(runDir, state);
    appendLedger(runDir, { agent: p.reviewer, piece, action: 'review', result: result.verdict, reason: result.reason, manual: true });
    return result;
  });
}
