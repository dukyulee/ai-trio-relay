// git 호출 래퍼. shell을 쓰지 않고 execFile에 인자 배열만 넘긴다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class GitError extends Error {
  constructor(args, code, stdout, stderr) {
    super(`git ${args.join(' ')} 실패(코드 ${code}): ${String(stderr || stdout).trim().slice(0, 800)}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// 외부 명령 실행(공용). shell:false 고정.
export function run(cmd, args, { cwd, env, input, timeout = 0, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, env, timeout, maxBuffer, shell: false, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

// trio가 부르는 git은 저장소 · worktree에 놓인 훅 · fsmonitor를 절대 돌리지 않는다(에이전트가 심은 훅이 HEAD 권한으로 돌지 않게).
// 빈 훅 폴더는 프로세스마다 새로 만든 무작위 이름이다.
let noHooksDir;
export function safeGitPrefix() {
  if (!noHooksDir) noHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trio-no-hooks-'));
  return ['-c', `core.hooksPath=${noHooksDir.replace(/\\/g, '/')}`, '-c', 'core.fsmonitor=false'];
}

export async function git(cwd, args, { input, env, allowFail = false } = {}) {
  try {
    const { stdout } = await run('git', [...safeGitPrefix(), ...args], { cwd, input, env: env ? { ...process.env, ...env } : undefined });
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    throw new GitError(args, err.code, err.stdout, err.stderr);
  }
}

// git 경로는 항상 '/'로 쓴다.
export function toGitPath(p) {
  return String(p).replace(/\\/g, '/');
}

export async function repoRoot(cwd) {
  return path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}

export async function revParse(cwd, ref) {
  const out = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
}

// 같은 저장소(.git 공용 폴더)에서 ref를 쓰는 작업이 겹치면 잠금 오류가 난다. 프로세스 안에서 줄을 세운다.
const repoLocks = new Map();
export async function withRepoLock(repoDir, fn) {
  const key = path.resolve(repoDir).toLowerCase();
  const prev = repoLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  repoLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === next) repoLocks.delete(key);
  }
}

function isTransient(err) {
  const s = String(err && (err.stderr || err.message) || '');
  return /cannot lock ref|unable to (create|lock)|index\.lock|could not lock|Another git process/i.test(s);
}

async function gitRetry(cwd, args, opts) {
  for (let i = 0; ; i++) {
    try {
      return await git(cwd, args, opts);
    } catch (err) {
      if (i >= 4 || !isTransient(err)) throw err;
      await sleep(50 + Math.random() * 150 * (i + 1));
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 원격 브랜치 하나를 원격 추적 ref로 받아 온다. 원격에 없으면 false(git 호출 한 번).
export async function fetchBranch(cwd, branch, remote = 'origin') {
  try {
    await gitRetry(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    return true;
  } catch (err) {
    if (/couldn't find remote ref|could not find remote ref/i.test(String(err.stderr || err.message))) {
      await git(cwd, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`], { allowFail: true });
      return false;
    }
    throw err;
  }
}

export async function remoteBranchExists(cwd, branch, remote = 'origin') {
  const out = await git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  return out.trim().length > 0;
}

export async function remoteBranchSha(cwd, branch, remote = 'origin') {
  const out = await git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  const line = out.trim().split('\n').find((l) => l.endsWith(`refs/heads/${branch}`));
  return line ? line.split(/\s+/)[0] : null;
}

// 전용 worktree(분리된 HEAD)를 준비한다. 지금 checkout된 브랜치와 겹치지 않게 늘 --detach로 만든다.
export async function ensureWorktree(repoDir, dir, ref) {
  const exists = fs.existsSync(path.join(dir, '.git'));
  if (!exists) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await gitRetry(repoDir, ['worktree', 'prune']);
    if (ref) {
      await gitRetry(repoDir, ['worktree', 'add', '--quiet', '--detach', dir, ref]);
    } else {
      await gitRetry(repoDir, ['worktree', 'add', '--quiet', '--detach', dir]);
    }
  } else if (ref) {
    await git(dir, ['reset', '--quiet', '--hard', ref]);
  }
  if (ref) await git(dir, ['clean', '-fdxq']);
  return dir;
}

export async function removeWorktree(repoDir, dir) {
  await git(repoDir, ['worktree', 'remove', '--force', dir], { allowFail: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune'], { allowFail: true });
}

function isRejected(err) {
  const s = String(err && (err.stderr || err.message) || '');
  return /rejected|non-fast-forward|fetch first|failed to push|cannot lock ref|stale info/i.test(s);
}

// 지금 HEAD를 원격 브랜치로 푸시한다. 거절(non-fast-forward)되면 fetch → rebase → push를 최대 retries번 한다.
// rebase가 충돌하면 원격 상태로 되돌리고 reapply()로 바뀐 내용을 다시 만든 뒤 커밋한다.
export async function pushWithRetry(cwd, branch, { remote = 'origin', retries = 5, reapply, message, lockDir } = {}) {
  const lock = lockDir || cwd;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await withRepoLock(lock, () => git(cwd, ['push', '--quiet', remote, `HEAD:refs/heads/${branch}`]));
      return { attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!isRejected(err) || attempt === retries) break;
      await sleep(20 + Math.random() * 120 * attempt);
      await withRepoLock(lock, () => fetchBranch(cwd, branch, remote));
      const onto = `refs/remotes/${remote}/${branch}`;
      const ok = await git(cwd, ['rebase', '--quiet', onto], { allowFail: true });
      if (ok === null) {
        await git(cwd, ['rebase', '--abort'], { allowFail: true });
        if (!reapply) throw new GitError(['rebase', onto], 1, '', '충돌 — 다시 적용할 방법(reapply)이 없다');
        await git(cwd, ['reset', '--quiet', '--hard', onto]);
        await git(cwd, ['clean', '-fdxq']);
        await reapply(cwd);
        await git(cwd, ['add', '-A']);
        if (await hasStaged(cwd)) await git(cwd, ['commit', '--quiet', '-m', message || 'trio: 다시 적용']);
      }
    }
  }
  throw lastErr;
}

export async function hasStaged(cwd) {
  const out = await git(cwd, ['diff', '--cached', '--name-only', '-z']);
  return out.length > 0;
}

// 마지막으로 푸시(또는 원격과 맞춤)한 뒤 손대지 않은 worktree. reuse일 때 fetch · reset을 건너뛴다.
// 원격이 그새 움직였으면 push가 거절되고 fetch → rebase로 따라잡으니 결과는 같다(git 호출만 준다).
const readyWorktrees = new Set();
const readyKey = (dir, branch) => `${path.resolve(dir).toLowerCase()}|${branch}`;

export function markWorktreeReady(dir, branch) {
  readyWorktrees.add(readyKey(dir, branch));
}

// 브랜치 하나에 파일 변경을 커밋하고 푸시한다(전용 worktree 사용).
// apply(worktreeDir)가 파일을 바꾼다. 브랜치가 없으면 createFrom(ref)에서, createFrom도 없으면 orphan으로 만든다.
export async function commitToBranch({ repoDir, worktreeDir, branch, apply, message, createFrom, remote = 'origin', retries = 5, reuse = false, wantSha = false }) {
  const key = readyKey(worktreeDir, branch);
  // apply()가 false를 돌려주면 바뀐 것 없음, true면 분명히 바뀜(검사 한 번을 건너뛴다).
  const body = async (wt) => {
    const changed = await apply(wt);
    if (changed === false) return { changed: false, sha: wantSha ? await revParse(wt, 'HEAD') : null };
    await git(wt, ['add', '-A']);
    if (changed !== true && !(await hasStaged(wt))) {
      return { changed: false, sha: wantSha ? await revParse(wt, 'HEAD') : null };
    }
    await git(wt, ['commit', '--quiet', '-m', message]);
    const reapply = async (dir) => { await apply(dir); };
    const res = await pushWithRetry(wt, branch, { remote, retries, reapply, message, lockDir: repoDir });
    return { changed: true, sha: wantSha ? await revParse(wt, 'HEAD') : null, attempts: res.attempts };
  };
  const ready = reuse && readyWorktrees.has(key) && fs.existsSync(path.join(worktreeDir, '.git'));
  readyWorktrees.delete(key);
  const res = ready ? await body(worktreeDir) : await withBranchWorktree({ repoDir, worktreeDir, branch, createFrom, remote }, body);
  readyWorktrees.add(key);
  return res;
}

// 브랜치의 최신 원격 상태로 worktree를 맞춘 뒤 fn(wt)을 부른다.
export async function withBranchWorktree({ repoDir, worktreeDir, branch, createFrom, remote = 'origin' }, fn) {
  const exists = await withRepoLock(repoDir, () => fetchBranch(repoDir, branch, remote));
  if (exists) {
    await withRepoLock(repoDir, () => ensureWorktree(repoDir, worktreeDir, `refs/remotes/${remote}/${branch}`));
  } else if (createFrom) {
    await withRepoLock(repoDir, () => ensureWorktree(repoDir, worktreeDir, createFrom));
  } else {
    await withRepoLock(repoDir, () => ensureWorktree(repoDir, worktreeDir, null));
    // orphan: 빈 역사에서 시작한다. 분리된 HEAD 상태에서 --orphan은 임시 브랜치 이름이 필요하다.
    const tmp = `trio-orphan-${process.pid}-${Date.now()}`;
    await git(worktreeDir, ['checkout', '--quiet', '--orphan', tmp]);
    await git(worktreeDir, ['rm', '-rfq', '--ignore-unmatch', '.']);
    await git(worktreeDir, ['clean', '-fdxq']);
    const res = await fn(worktreeDir);
    await git(worktreeDir, ['checkout', '--quiet', '--detach'], { allowFail: true });
    await git(worktreeDir, ['branch', '-D', tmp], { allowFail: true });
    return res;
  }
  return fn(worktreeDir);
}

// 시험 · 예시용: ref:path 파일 내용 읽기(없으면 null).
export async function showFile(cwd, ref, filePath) {
  return git(cwd, ['show', `${ref}:${toGitPath(filePath)}`], { allowFail: true });
}

export async function listTree(cwd, ref, prefix = '') {
  const args = ['ls-tree', '-r', '-z', '--name-only', ref];
  if (prefix) args.push('--', prefix);
  const out = await git(cwd, args, { allowFail: true });
  if (!out) return [];
  return out.split('\0').filter(Boolean);
}
