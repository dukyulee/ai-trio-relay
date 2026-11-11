// Antigravity 로컬 어댑터: 에이전트 폴더에서 `agy -p <지시> --mode accept-edits --sandbox --output-format json`(검토는 --mode plan).
//
// 에이전트 폴더에서는 git을 한 번도 돌리지 않는다(에이전트가 `.git`을 바꿔 훅 · fsmonitor를 심어도 HEAD 권한으로 돌지 않게).
//   - 에이전트 폴더 = OS 임시 폴더 아래 무작위 이름(실행 폴더와 다른 트리). git 메타 없이 파일만 있다.
//   - 채우기: HEAD 전용 worktree(실행 폴더 안)를 조각 브랜치에 맞춘 뒤 파일만 복사한다.
//   - 가져오기: 에이전트 폴더를 lstat으로 걸으며 HEAD 전용 worktree에 그대로 비춘다(삭제 포함). `.git` 이름은 뺀다.
//     심볼릭 링크 · 정션 · 특수 파일은 따라가지 않고 위반, 개수 · 크기 상한을 넘어도 위반.
//   - 그다음 HEAD worktree에서 커밋 → 범위 검사 → fast-forward 푸시.
// 환경 변수는 허용 목록만 넘기고 git 자격 증명을 끈다. 출력 · 한도 오류 형식은 착수 때 확인 대상이다(A2).
import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, ensureWorktree, fetchBranch, hasStaged, withRepoLock, revParse } from '../gitops.mjs';
import { recordSession } from '../ledger.mjs';
import { assertSafeArgs, assertSafeExtraArgs, stripSecrets, killTree, looksLikeLimit, extractResultText, processInfo } from './common.mjs';

export const LIMITS = { maxFiles: 5000, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };

// 확인 A1(2026-11-11 · agy 1.5.3): `--sandbox`는 터미널만 막고, 파일 도구는 폴더 밖 절대 경로를 읽고 쓴다.
// 그래서 agy는 실험 기능이고 기본으로 꺼져 있다. 사용자가 agy settings.json에 민감 경로 deny 규칙을 둔 뒤
// `.trio/config.json`에 `"antigravity": { "experimental": true }`를 넣어야 켜진다.
export const AGY_DISABLED_MESSAGE =
  'Antigravity(agy)는 실험 기능이라 꺼져 있다 — agy 파일 도구가 작업 폴더 밖을 읽고 쓸 수 있다(docs/verified.md A1). ' +
  '쓰려면 README 「Antigravity 켜기」대로 agy 권한 규칙을 먼저 두고 .trio/config.json에 "antigravity": { "experimental": true }를 넣는다. ' +
  '아니면 그 조각의 agent를 claude 또는 codex로 바꾼다.';
export const agyEnabled = (config = {}) => !!(config.antigravity && config.antigravity.experimental === true);

export function buildAgyCommand({ prompt, mode = 'author', resume = false, extraArgs = [] }) {
  assertSafeExtraArgs(extraArgs);
  const args = [];
  if (resume) args.push('--continue');
  args.push('-p', prompt, '--mode', mode === 'review' ? 'plan' : 'accept-edits', '--sandbox', '--output-format', 'json', ...extraArgs);
  return { cmd: 'agy', args: assertSafeArgs(args, { free: [prompt] }) };
}

const isGitMeta = (name) => name.toLowerCase() === '.git';

// 폴더를 lstat으로 걷는다. 링크 · 특수 파일은 따라가지 않고 위반으로 모은다.
export function scanTree(root, limits = LIMITS) {
  const files = [];
  const violations = [];
  let total = 0;
  const walk = (dirAbs, rel) => {
    for (const name of fs.readdirSync(dirAbs).sort()) {
      if (isGitMeta(name)) continue;
      const abs = path.join(dirAbs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) { violations.push({ path: r, rule: 'symlink' }); continue; }
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (!st.isFile()) { violations.push({ path: r, rule: 'special-file' }); continue; }
      if (st.size > limits.maxFileBytes) { violations.push({ path: r, rule: `file-too-large:${st.size}` }); continue; }
      total += st.size;
      files.push({ rel: r, abs, size: st.size });
    }
  };
  walk(root, '');
  if (files.length > limits.maxFiles) violations.push({ path: '*', rule: `too-many-files:${files.length}>${limits.maxFiles}` });
  if (total > limits.maxTotalBytes) violations.push({ path: '*', rule: `too-large:${total}>${limits.maxTotalBytes}` });
  return { files, violations };
}

// 폴더 내용 지문(경로 · 크기 · 해시). 검토 중 바뀌었는지 git 없이 본다.
export function treeFingerprint(root) {
  const { files, violations } = scanTree(root);
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${f.rel}\0${crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex')}\0`);
  for (const v of violations) h.update(`!${v.path}\0${v.rule}\0`);
  return h.digest('hex');
}

const NO_LIMIT = { maxFiles: Infinity, maxFileBytes: Infinity, maxTotalBytes: Infinity };
const hashFile = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const manifestOf = (files) => new Map(files.map((f) => [f.rel, hashFile(f.abs)]));

// HEAD worktree의 파일만 에이전트 폴더로 복사한다(.git 제외 · 링크는 건너뜀 — 범위 검사가 링크를 따로 막는다).
// 돌려주는 것: 채운 순간의 지문(경로 → 해시) — 가져올 때 「에이전트가 바꾼 것」만 고르는 기준이다.
function fillAgentDir(fromWt, toDir) {
  const { files } = scanTree(fromWt, NO_LIMIT);
  for (const f of files) {
    const dst = path.join(toDir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.abs, dst);
  }
  return manifestOf(files);
}

// 에이전트가 기준(baseline)에서 바꾼 것만 HEAD worktree(원격 끝)에 얹는다(3방향).
// 같은 파일을 원격도 그새 바꿨으면(임대 승인 ORDER 등) 덮지 않고 충돌로 본다.
// 「없음」은 양쪽 모두 null로 맞춰 비교한다 — 에이전트도 지우고 원격에도 없으면 합의다(3차 검수 중간-1).
// `.trio/outbox/**`는 중계가 원격에서 지운다. 원격에 없으면 에이전트 쪽을 새 파일(또는 이미 끝난 삭제)로 본다.
export function applyAgentChanges(files, baseline, wt) {
  const cur = manifestOf(files);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const changed = [...cur].filter(([rel, h]) => baseline.get(rel) !== h).map(([rel]) => rel);
  const deleted = [...baseline.keys()].filter((rel) => !cur.has(rel));
  const conflicts = [];
  const there = (rel) => {
    const abs = path.join(wt, ...rel.split('/'));
    try { return fs.lstatSync(abs).isFile() ? hashFile(abs) : '<not-file>'; } catch { return null; }
  };
  for (const rel of [...changed, ...deleted]) {
    const remote = there(rel);
    const base = baseline.has(rel) ? baseline.get(rel) : null;
    const mine = cur.has(rel) ? cur.get(rel) : null;
    if (remote === null && rel.startsWith('.trio/outbox/')) continue;
    if (remote !== base && remote !== mine) conflicts.push({ path: rel, rule: 'conflict-with-remote' });
  }
  if (conflicts.length) return { conflicts, manifest: cur };
  for (const rel of changed) {
    const dst = path.join(wt, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(byRel.get(rel).abs, dst);
  }
  for (const rel of deleted) fs.rmSync(path.join(wt, ...rel.split('/')), { force: true });
  return { conflicts: [], manifest: cur };
}

export function createAntigravityLocalAdapter({ repoDir, runDir, config = {}, spawn = nodeSpawn, agentRoot = os.tmpdir() }) {
  const cfg = config.antigravity || {};
  const extraArgs = cfg.extraArgs || [];

  function launch(h, prompt, resume) {
    const { cmd, args } = buildAgyCommand({ prompt, mode: h.mode, resume, extraArgs });
    const child = spawn(cmd, args, {
      cwd: h.agentDir, env: stripSecrets(process.env), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proc = { child, pid: child.pid, stdout: '', stderr: '', exit: null };
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    const log = fs.createWriteStream(path.join(runDir, 'logs', `agy-${h.piece}-${h.mode}-${Date.now()}.log`));
    child.stdout.on('data', (d) => { proc.stdout += d; log.write(d); });
    child.stderr.on('data', (d) => { proc.stderr += d; log.write(d); });
    child.on('error', (err) => { proc.exit = { code: -1, error: err.message }; log.end(); });
    child.on('close', (code) => { if (!proc.exit) proc.exit = { code }; log.end(); });
    // PID만 적으면 나중에 다른 프로세스가 같은 번호를 받을 수 있다. 시작 시각 · 이름도 적어 `trio stop`이 대조한다.
    proc.recorded = processInfo(child.pid).then((info) => recordSession(runDir, { piece: h.piece, agent: 'antigravity', kind: 'pid', mode: h.mode, pid: child.pid, info }));
    return { ...h, proc, startPrint: treeFingerprint(h.agentDir), startedAt: new Date().toISOString() };
  }

  return {
    name: 'antigravity',
    // 샌드박스 안에서 폴더 밖(전달함)에 못 쓸 수 있어, 편지는 에이전트 폴더 안 .trio/outbox로 낸다(중계).
    capability: { canPushMailbox: false, canPushBranch: false, reviewMode: 'output', reviewToken: false },

    async start({ order, branch, prompt, mode = 'author', token = '' }) {
      const headWt = path.join(runDir, 'worktrees', `agy-${order.id}-${mode}`);
      await withRepoLock(repoDir, async () => {
        await fetchBranch(repoDir, branch);
        await ensureWorktree(repoDir, headWt, `refs/remotes/origin/${branch}`);
      });
      const agentDir = fs.mkdtempSync(path.join(agentRoot, 'trio-agent-'));
      const baseline = fillAgentDir(headWt, agentDir);
      return launch({ agent: 'antigravity', piece: order.id, branch, mode, headWt, agentDir, token, baseline }, prompt, false);
    },

    async poll(h) {
      const e = h.proc && h.proc.exit;
      if (!e) return { state: 'running' };
      const text = `${h.proc.stdout}\n${h.proc.stderr}`;
      if (e.code !== 0) return { state: looksLikeLimit(text) ? 'limit' : 'failed', detail: (e.error || text).slice(-500) };
      if (h.mode !== 'review') return { state: 'done' };
      // 검토자 폴더가 조금이라도 바뀌었으면 코드 섞임(git을 돌리지 않고 지문으로 본다).
      return { state: 'done', detail: { reviewText: extractResultText(h.proc.stdout), changed: treeFingerprint(h.agentDir) !== h.startPrint } };
    },

    // 에이전트 폴더 → HEAD worktree로 가져와 커밋 → 범위 검사 → fast-forward 푸시. 같은 핸들은 한 번만.
    async collect(h, { checkScope } = {}) {
      if (h.collected) return h.collected;
      const scan = scanTree(h.agentDir);
      if (scan.violations.length) {
        h.collected = { applied: false, pushed: false, scope: { ok: false, violations: scan.violations, changes: [] } };
        return h.collected;
      }
      const remote = await withRepoLock(repoDir, async () => {
        await fetchBranch(repoDir, h.branch);
        await ensureWorktree(repoDir, h.headWt, `refs/remotes/origin/${h.branch}`);
        return revParse(repoDir, `refs/remotes/origin/${h.branch}`);
      });
      const applied = applyAgentChanges(scan.files, h.baseline, h.headWt);
      if (applied.conflicts.length) {
        h.collected = { applied: false, pushed: false, scope: { ok: false, violations: applied.conflicts, changes: [] } };
        return h.collected;
      }
      await git(h.headWt, ['add', '-A']);
      if (await hasStaged(h.headWt)) await git(h.headWt, ['commit', '--quiet', '-m', `trio: antigravity 결과(${h.piece})`]);
      const head = await revParse(h.headWt, 'HEAD');
      if (head === remote) {
        h.collected = { applied: false, pushed: false };
        return h.collected;
      }
      if (checkScope) {
        const scope = await checkScope(h.headWt);
        if (!scope.ok) {
          h.collected = { applied: true, pushed: false, scope };
          return h.collected;
        }
      }
      // fast-forward만: 원격이 그새 바뀌었으면 거절된다(강제 푸시 없음).
      await withRepoLock(repoDir, () => git(h.headWt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${h.branch}`]));
      h.baseline = applied.manifest; // 다음 가져오기의 기준 = 지금 올린 에이전트 폴더
      h.collected = { applied: true, pushed: true, sha: head };
      return h.collected;
    },

    async followUp(h, message, { token } = {}) {
      return launch({ ...h, collected: null, token: token || h.token }, message, true);
    },

    async stop(h) {
      if (!h || !h.proc) return { stopped: false };
      await killTree(h.proc.pid);
      return { stopped: true };
    },
  };
}
