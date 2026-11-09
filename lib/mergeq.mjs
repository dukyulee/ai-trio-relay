// 병합 줄: 통과한 조각을 의존 순서대로 integration 브랜치에 하나씩 합치고, 합칠 때마다 전체 verify를 돌린다.
import fs from 'node:fs';
import path from 'node:path';
import { git, run, revParse, fetchBranch, ensureWorktree, withRepoLock } from './gitops.mjs';
import { ENV_ALLOW, allowEnv } from './adapters/common.mjs';

// 명령 문자열을 shell 없이 인자 배열로 나눈다. 따옴표('…' "…")만 해석하고, shell 연산자가 있으면 거부한다.
export function splitCommand(cmd) {
  if (Array.isArray(cmd)) {
    if (!cmd.length || cmd.some((a) => typeof a !== 'string')) throw new Error('verify 배열이 바르지 않다');
    return [...cmd];
  }
  const s = String(cmd);
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    if ('|&;<>`$(){}'.includes(c)) throw new Error(`verify 명령에 shell 연산자 "${c}"가 있다 — 배열로 쓰거나 스크립트 파일로 옮긴다`);
    cur += c;
    has = true;
  }
  if (quote) throw new Error('verify 명령의 따옴표가 닫히지 않았다');
  if (has) out.push(cur);
  if (!out.length) throw new Error('verify 명령이 비었다');
  return out;
}

// Windows에서 npm · npx는 .cmd라 shell 없이 못 부른다. 같은 node로 npm-cli.js를 부른다.
export function resolveCommand(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'node') return [process.execPath, ...rest];
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${cmd}-cli.js`);
    if (fs.existsSync(cli)) return [process.execPath, cli, ...rest];
    throw new Error(`${cmd}를 shell 없이 부를 수 없다 — verify를 "node …" 형식으로 쓴다`);
  }
  return argv;
}

// verify는 에이전트가 쓴 코드를 이 PC에서 돌린다. 사용자 환경 변수(토큰 등)를 넘기지 않고, 허용 목록(어댑터와 같은 것)만 준다.
export const VERIFY_ENV_KEYS = ENV_ALLOW;

export function verifyEnv(env = process.env) {
  return { ...allowEnv(env), CI: '1' };
}

export async function runVerify(cwd, cmd, { timeout = 10 * 60 * 1000, env = verifyEnv() } = {}) {
  const argv = resolveCommand(splitCommand(cmd));
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), { cwd, timeout, env });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}${err.message}`.slice(-8000) };
  }
}

// 병합 줄. pieces: 통과한 조각(의존 순서) — 각자 passedSha(범위 검사 · 검토를 거친 커밋)가 있어야 한다.
// baseSha · integrationSha: HEAD가 만든(마지막으로 푸시한) 값. 원격이 다르면 아무것도 합치지 않고 멈춘다.
// integration 푸시는 rebase 없이 --force-with-lease=<알려진 sha>로만 한다(남이 그새 바꿨으면 거절된다).
// 결과: [{id, state, detail}], integrationSha(마지막)
export async function mergeQueue({ repoDir, run: runId, pieces, verify, worktreeDir, baseSha, integrationSha, notify = async () => {}, isStopped = () => false, onEvent = () => {}, onIntegration = () => {} }) {
  const integration = `trio/${runId}/integration`;
  const base = `trio/${runId}/base`;
  const results = [];
  const stopAll = (state, detail) => {
    for (const p of pieces) if (!results.some((r) => r.id === p.id)) results.push({ id: p.id, state, detail });
    return { results, integrationSha: known };
  };
  let known = integrationSha;
  if (!baseSha || !known) return stopAll('MERGE_ABORTED', 'HEAD가 만든 base · integration 기록이 없다');
  await withRepoLock(repoDir, async () => {
    await fetchBranch(repoDir, base);
    await fetchBranch(repoDir, integration);
  });
  const remoteBase = await revParse(repoDir, `refs/remotes/origin/${base}`);
  if (remoteBase !== baseSha) return stopAll('BASE_CHANGED', `원격 base(${String(remoteBase).slice(0, 12)})가 HEAD 기록과 다르다`);
  const remoteInteg = await revParse(repoDir, `refs/remotes/origin/${integration}`);
  if (remoteInteg !== known) return stopAll('INTEGRATION_CHANGED', `원격 integration(${String(remoteInteg).slice(0, 12)})이 HEAD 기록과 다르다`);
  await withRepoLock(repoDir, () => ensureWorktree(repoDir, worktreeDir, known));
  const merged = new Set();
  for (const p of pieces) {
    if (isStopped()) {
      results.push({ id: p.id, state: 'STOPPED', detail: '정지됨 — 병합하지 않는다' });
      continue;
    }
    const missing = (p.deps || []).filter((d) => !merged.has(d));
    if (missing.length) {
      results.push({ id: p.id, state: 'DEP_FAILED', detail: `의존 조각이 합쳐지지 않았다: ${missing.join(', ')}` });
      await notify(p, 'DEP_FAILED', `의존 조각(${missing.join(', ')})이 합쳐지지 않아 이 조각도 합치지 않았다.`);
      continue;
    }
    if (!p.passedSha) {
      results.push({ id: p.id, state: 'NOT_REVIEWED', detail: '검토를 통과한 커밋 기록이 없다' });
      continue;
    }
    await withRepoLock(repoDir, () => fetchBranch(repoDir, p.branch));
    const tip = await revParse(repoDir, `refs/remotes/origin/${p.branch}`);
    if (tip !== p.passedSha) {
      // 검토를 통과한 뒤 브랜치가 움직였다(검토자 · 작성자가 편지 뒤에 푸시한 경우 포함).
      results.push({ id: p.id, state: 'CHANGED_AFTER_REVIEW', detail: `검토한 ${p.passedSha.slice(0, 12)} ≠ 원격 ${String(tip).slice(0, 12)}` });
      await notify(p, 'CHANGED_AFTER_REVIEW', '검토를 통과한 뒤 조각 브랜치가 바뀌어 합치지 않았다. 사람이 확인한다.');
      onEvent({ id: p.id, state: 'CHANGED_AFTER_REVIEW' });
      continue;
    }
    const pre = await revParse(worktreeDir, 'HEAD');
    const mergedOk = await git(worktreeDir, ['merge', '--no-ff', '--no-edit', '-m', `trio: ${p.id} 합치기`, p.passedSha], { allowFail: true });
    if (mergedOk === null) {
      await git(worktreeDir, ['merge', '--abort'], { allowFail: true });
      await git(worktreeDir, ['reset', '--quiet', '--hard', pre]);
      results.push({ id: p.id, state: 'MERGE_CONFLICT', detail: '충돌' });
      await notify(p, 'MERGE_CONFLICT', 'integration에 합치다 충돌했다. base 위에서 다시 맞춰 달라.');
      onEvent({ id: p.id, state: 'MERGE_CONFLICT' });
      continue;
    }
    // 작성자 편지 자리는 병합 전에 뺀다.
    if (fs.existsSync(path.join(worktreeDir, '.trio', 'outbox'))) {
      await git(worktreeDir, ['rm', '-r', '-q', '--ignore-unmatch', '.trio/outbox']);
      await git(worktreeDir, ['commit', '--quiet', '--amend', '--no-edit']);
    }
    const v = await runVerify(worktreeDir, verify);
    if (!v.ok) {
      await git(worktreeDir, ['reset', '--quiet', '--hard', pre]);
      results.push({ id: p.id, state: 'VERIFY_FAILED', detail: v.output.slice(-2000) });
      await notify(p, 'VERIFY_FAILED', `합친 뒤 전체 시험이 실패해 되돌렸다.

${v.output.slice(-1500)}`);
      onEvent({ id: p.id, state: 'VERIFY_FAILED' });
      continue;
    }
    if (isStopped()) {
      await git(worktreeDir, ['reset', '--quiet', '--hard', pre]);
      results.push({ id: p.id, state: 'STOPPED', detail: '정지됨 — 푸시하지 않았다' });
      continue;
    }
    const pushed = await withRepoLock(repoDir, () => git(worktreeDir, ['push', '--quiet', `--force-with-lease=refs/heads/${integration}:${known}`, 'origin', `HEAD:refs/heads/${integration}`], { allowFail: true }));
    if (pushed === null) {
      await git(worktreeDir, ['reset', '--quiet', '--hard', pre]);
      results.push({ id: p.id, state: 'INTEGRATION_CHANGED', detail: 'integration 푸시가 거절됐다(그새 누가 바꿨다)' });
      return stopAll('INTEGRATION_CHANGED', 'integration이 바뀌어 병합 줄을 멈췄다');
    }
    known = await revParse(worktreeDir, 'HEAD');
    onIntegration(known);
    merged.add(p.id);
    results.push({ id: p.id, state: 'MERGED', detail: known });
    onEvent({ id: p.id, state: 'MERGED' });
  }
  return { results, integrationSha: known };
}
