// 병합 줄(B1 검토한 커밋만 · B2 base/integration 대조 · H7 경로 가리기)과 결과 반영(H3 푸시 전 범위 검사 · H8 · M7 · H4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mergeQueue } from '../lib/mergeq.mjs';
import { git, remoteBranchSha } from '../lib/gitops.mjs';
import { Mailbox, MAILBOX_BRANCH } from '../lib/mailbox.mjs';
import { checkScope } from '../lib/scope.mjs';
import { createCodexWebAdapter } from '../lib/adapters/codex-web.mjs';
import { createAntigravityLocalAdapter } from '../lib/adapters/antigravity-local.mjs';
import { setupRepo, writeFiles, CALC } from './helpers.mjs';

const VERIFY = ['node', '--test', 'test/*.test.js'];

// main에서 base · integration · 조각 브랜치를 만든다. 조각에는 files를 커밋한다.
async function branches(env, run, piece, files) {
  const baseSha = (await git(env.work, ['rev-parse', 'HEAD'])).trim();
  await git(env.work, ['push', '--quiet', 'origin', `${baseSha}:refs/heads/trio/${run}/base`, `${baseSha}:refs/heads/trio/${run}/integration`]);
  await git(env.work, ['checkout', '--quiet', '-B', `trio/${run}/${piece}`, baseSha]);
  if (files) {
    writeFiles(env.work, files);
    await git(env.work, ['add', '-A']);
    await git(env.work, ['commit', '--quiet', '-m', `${piece} 구현`]);
  }
  await git(env.work, ['push', '--quiet', 'origin', `HEAD:refs/heads/trio/${run}/${piece}`]);
  const sha = (await git(env.work, ['rev-parse', 'HEAD'])).trim();
  await git(env.work, ['checkout', '--quiet', 'main']);
  return { baseSha, sha };
}

const pick = (keys) => Object.fromEntries(keys.map((k) => [k, CALC[k]]));

test('B1: 병합 줄은 검토를 통과한 커밋만 합친다 — 그 뒤 푸시가 있으면 CHANGED_AFTER_REVIEW', async () => {
  const env = await setupRepo();
  const { baseSha, sha } = await branches(env, 'm1', 'add', pick(['src/add.js', 'test/add.test.js']));
  // 검토(sha) 뒤 누가 같은 브랜치에 푸시했다
  await git(env.work, ['checkout', '--quiet', '-B', 'late', sha]);
  writeFiles(env.work, { 'src/add.js': 'export const add = () => 42;\n' });
  await git(env.work, ['commit', '--quiet', '-am', '검토 뒤 몰래']);
  await git(env.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/trio/m1/add']);
  await git(env.work, ['checkout', '--quiet', 'main']);
  const piece = { id: 'add', agent: 'claude', deps: [], branch: 'trio/m1/add', passedSha: sha };
  const wt = path.join(env.root, 'integ');
  const r = await mergeQueue({ repoDir: env.work, run: 'm1', pieces: [piece], verify: VERIFY, worktreeDir: wt, baseSha, integrationSha: baseSha });
  assert.equal(r.results[0].state, 'CHANGED_AFTER_REVIEW');
  assert.equal(await remoteBranchSha(env.work, 'trio/m1/integration'), baseSha, 'integration은 그대로');
  // passedSha가 없으면 합치지 않는다
  const r2 = await mergeQueue({ repoDir: env.work, run: 'm1', pieces: [{ ...piece, passedSha: null }], verify: VERIFY, worktreeDir: wt, baseSha, integrationSha: baseSha });
  assert.equal(r2.results[0].state, 'NOT_REVIEWED');
  // 원격 끝이 검토한 커밋과 같을 때만 합친다 — 합친 커밋의 둘째 부모 = 검토한 커밋
  const tip = await remoteBranchSha(env.work, 'trio/m1/add');
  const r3 = await mergeQueue({ repoDir: env.work, run: 'm1', pieces: [{ ...piece, passedSha: tip }], verify: ['node', '-e', 'process.exit(0)'], worktreeDir: wt, baseSha, integrationSha: baseSha });
  assert.equal(r3.results[0].state, 'MERGED');
  assert.equal(await remoteBranchSha(env.work, 'trio/m1/integration'), r3.integrationSha);
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.equal((await git(env.work, ['rev-parse', `${r3.integrationSha}^2`])).trim(), tip);
});

test('B2: 원격 base · integration이 HEAD 기록과 다르면 아무것도 합치지 않는다', async () => {
  const env = await setupRepo();
  const { baseSha, sha } = await branches(env, 'm2', 'add', pick(['src/add.js', 'test/add.test.js']));
  const piece = { id: 'add', agent: 'claude', deps: [], branch: 'trio/m2/add', passedSha: sha };
  const wt = path.join(env.root, 'integ');
  // integration에 누가 다른 커밋을 올렸다
  await git(env.work, ['checkout', '--quiet', '-B', 'evil', baseSha]);
  writeFiles(env.work, { 'evil.txt': 'x\n' });
  await git(env.work, ['add', '-A']);
  await git(env.work, ['commit', '--quiet', '-m', 'evil']);
  await git(env.work, ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/trio/m2/integration']);
  const evil = (await git(env.work, ['rev-parse', 'HEAD'])).trim();
  let r = await mergeQueue({ repoDir: env.work, run: 'm2', pieces: [piece], verify: VERIFY, worktreeDir: wt, baseSha, integrationSha: baseSha });
  assert.equal(r.results[0].state, 'INTEGRATION_CHANGED');
  assert.equal(await remoteBranchSha(env.work, 'trio/m2/integration'), evil, '남의 integration 위에 합치지 않는다');
  // base가 움직였다
  await git(env.work, ['push', '--quiet', '--force', 'origin', `${baseSha}:refs/heads/trio/m2/integration`]);
  await git(env.work, ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/trio/m2/base']);
  r = await mergeQueue({ repoDir: env.work, run: 'm2', pieces: [piece], verify: VERIFY, worktreeDir: wt, baseSha, integrationSha: baseSha });
  assert.equal(r.results[0].state, 'BASE_CHANGED');
  // 기록이 없으면 시작도 하지 않는다
  r = await mergeQueue({ repoDir: env.work, run: 'm2', pieces: [piece], verify: VERIFY, worktreeDir: wt, baseSha: null, integrationSha: null });
  assert.equal(r.results[0].state, 'MERGE_ABORTED');
  await git(env.work, ['checkout', '--quiet', 'main']);
});

test('H7: VERIFY_FAILED 편지에 이 PC 경로가 나가지 않는다', async () => {
  const env = await setupRepo();
  const { baseSha, sha } = await branches(env, 'm3', 'add', pick(['src/add.js', 'test/add.test.js']));
  const stateDir = path.join(env.root, 'run-state');
  const mb = new Mailbox({ repoDir: env.work, run: 'm3', worktreeDir: path.join(stateDir, 'worktrees', 'mailbox'), stateDir, redactPaths: [env.root] });
  await mb.init();
  const sent = [];
  const notify = async (p, st, body) => sent.push(await mb.send({ from: 'head', to: p.agent, type: 'review', order: p.id, needs_reply: false, body: `병합 줄 ${st}\n${body}` }));
  const wt = path.join(stateDir, 'worktrees', 'integration');
  const verify = ['node', '-e', 'console.error("실패 at " + process.cwd() + " / " + require("os").homedir()); process.exit(1)'];
  const r = await mergeQueue({ repoDir: env.work, run: 'm3', pieces: [{ id: 'add', agent: 'claude', deps: [], branch: 'trio/m3/add', passedSha: sha }], verify, worktreeDir: wt, baseSha, integrationSha: baseSha, notify });
  assert.equal(r.results[0].state, 'VERIFY_FAILED');
  assert.ok(r.results[0].detail.includes('실패 at'), '로컬 기록에는 원문이 남는다');
  const stored = await git(env.work, ['show', `origin/${MAILBOX_BRANCH}:${sent[0].path}`]);
  assert.match(stored, /실패 at/);
  for (const bad of [wt, env.root, os.homedir()]) assert.ok(!stored.includes(bad), `편지에 경로가 남았다: ${bad}`);
  assert.equal(await remoteBranchSha(env.work, 'trio/m3/integration'), baseSha, '되돌렸다');
});

// 가짜 exec: Codex cloud diff만 돌려준다(실제 codex를 부르지 않는다).
function fakeCodex(patch, calls) {
  return async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'diff') return { stdout: patch };
    throw new Error('부르면 안 되는 명령');
  };
}

async function patchOf(env, files) {
  await git(env.work, ['checkout', '--quiet', '-B', 'patch-tmp', 'main']);
  writeFiles(env.work, files);
  await git(env.work, ['add', '-A']);
  const patch = await git(env.work, ['diff', '--cached', '--binary']);
  await git(env.work, ['reset', '--quiet', '--hard']);
  await git(env.work, ['clean', '-fdq']);
  await git(env.work, ['checkout', '--quiet', 'main']);
  return patch;
}

const mulOrder = { allowed_paths: ['src/mul.js', 'test/mul.test.js'], protected_paths: ['src/types.js'], max_files: 5, max_diff_lines: 200 };

test('H3 · H7 · M7: Codex 결과는 범위 검사를 통과해야 푸시하고, 커밋 메시지에 작업 ID가 없고, 두 번 적용하지 않는다', async () => {
  const env = await setupRepo();
  const { baseSha } = await branches(env, 'c1', 'mul', null);
  const runDir = path.join(env.root, 'run-dir');
  const scopeOf = (wt) => checkScope({ repoDir: wt, base: baseSha, head: 'HEAD', order: mulOrder });
  // 1) .github/workflows를 건드린 결과 → 푸시하지 않는다
  const bad = await patchOf(env, { ...pick(['src/mul.js']), '.github/workflows/x.yml': 'on: push\n' });
  let calls = [];
  let ad = createCodexWebAdapter({ repoDir: env.work, runDir, config: { codex: { envId: 'e' } }, exec: fakeCodex(bad, calls) });
  let h = { piece: 'mul', branch: 'trio/c1/mul', taskId: 'task_SECRETID123', mode: 'author' };
  let c = await ad.collect(h, { checkScope: scopeOf });
  assert.equal(c.pushed, false);
  assert.ok(c.scope.violations.some((v) => v.path === '.github/workflows/x.yml' && v.rule === 'protected'));
  assert.equal(await remoteBranchSha(env.work, 'trio/c1/mul'), baseSha, 'GitHub에 올라가지 않았다');
  // 2) 범위 안 결과 → 푸시, 메시지에 작업 ID 없음, 다시 불러도 다시 적용하지 않는다
  const good = await patchOf(env, pick(['src/mul.js', 'test/mul.test.js']));
  calls = [];
  ad = createCodexWebAdapter({ repoDir: env.work, runDir, config: { codex: { envId: 'e' } }, exec: fakeCodex(good, calls) });
  h = { piece: 'mul', branch: 'trio/c1/mul', taskId: 'task_SECRETID123', mode: 'author' };
  c = await ad.collect(h, { checkScope: scopeOf });
  assert.equal(c.pushed, true);
  const tip = await remoteBranchSha(env.work, 'trio/c1/mul');
  assert.equal(tip, c.sha);
  await git(env.work, ['fetch', '--quiet', 'origin']);
  const msg = await git(env.work, ['log', '-1', '--format=%B', tip]);
  assert.ok(!msg.includes('task_SECRETID123'), msg);
  const again = await ad.collect(h, { checkScope: scopeOf });
  assert.equal(again, c);
  assert.equal(calls.filter((x) => x.includes('diff')).length, 1, 'diff는 한 번만');
  assert.equal(await remoteBranchSha(env.work, 'trio/c1/mul'), tip);
});

function fakeSpawn(record) {
  return (cmd, args, opts) => {
    record.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = process.pid;
    setImmediate(() => { child.stdout.emit('data', '{"result":"ok"}'); child.emit('close', 0); });
    return child;
  };
}

test('H4 · H5 · H6 · H8 · H3 · L2: agy 폴더는 git 없는 임시 폴더, 비밀 env 없음, 파일로 가져와 HEAD worktree에서 커밋 · 범위 검사 · fast-forward 푸시', async () => {
  const env = await setupRepo();
  const { baseSha } = await branches(env, 'a1', 'format', null);
  const runDir = path.join(env.root, 'run-dir');
  fs.mkdirSync(runDir, { recursive: true });
  const spawned = [];
  process.env.TRIO_TEST_SECRET_TOKEN = 'zzz';
  let h;
  const ad = createAntigravityLocalAdapter({ repoDir: env.work, runDir, spawn: fakeSpawn(spawned) });
  try {
    h = await ad.start({ order: { id: 'format' }, branch: 'trio/a1/format', prompt: '지시', mode: 'author' });
  } finally {
    delete process.env.TRIO_TEST_SECRET_TOKEN;
  }
  // H5: 에이전트 폴더는 OS 임시 폴더 아래 무작위 이름 — 실행 폴더와 다른 트리, git 메타 없음
  assert.ok(path.relative(path.resolve(runDir), path.resolve(h.agentDir)).startsWith('..'), h.agentDir);
  assert.ok(path.relative(path.resolve(h.agentDir), path.resolve(runDir)).startsWith('..'));
  assert.match(path.basename(h.agentDir), /^trio-agent-/);
  assert.ok(!fs.existsSync(path.join(h.agentDir, '.git')), '에이전트 폴더에 .git이 없다');
  assert.ok(fs.existsSync(path.join(h.agentDir, 'src', 'types.js')), '파일은 채워졌다');
  assert.equal(spawned[0].opts.cwd, h.agentDir);
  assert.equal(spawned[0].opts.env.TRIO_TEST_SECRET_TOKEN, undefined);
  assert.equal(spawned[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  await h.proc.recorded;
  // 에이전트가 파일을 쓰고 · 지운다(git 없이)
  writeFiles(h.agentDir, pick(['src/format.js']));
  const order = { allowed_paths: ['src/format.js', 'test/format.test.js', 'README.md'], protected_paths: [], max_files: 5, max_diff_lines: 200 };
  const scopeOf = (wt) => checkScope({ repoDir: wt, base: baseSha, head: 'HEAD', order });
  const c = await ad.collect(h, { checkScope: scopeOf });
  assert.equal(c.pushed, true, JSON.stringify(c));
  assert.equal(await remoteBranchSha(env.work, 'trio/a1/format'), c.sha);
  // H4: 에이전트가 `.git` 파일 · 훅 · fsmonitor를 심어도 HEAD가 그것을 돌리지 않는다
  const marker = path.join(env.root, 'HOOK-RAN.txt');
  const hookScript = `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`;
  const h2 = await ad.followUp(h, '후속');
  fs.writeFileSync(path.join(h2.agentDir, '.git'), 'gitdir: ./.x\n');
  writeFiles(h2.agentDir, {
    '.x/HEAD': 'ref: refs/heads/main\n',
    '.x/config': `[core]\n\thooksPath = hooks\n\tfsmonitor = ${marker.replace(/\\/g, '/')}.sh\n`,
    '.x/hooks/pre-commit': hookScript,
    '.x/hooks/post-commit': hookScript,
    'README.md': '바꿈\n',
  });
  fs.rmSync(path.join(h2.agentDir, 'src', 'format.js')); // 지운 파일도 반영돼야 한다
  const c2 = await ad.collect(h2, { checkScope: scopeOf });
  assert.ok(!fs.existsSync(marker), '에이전트가 심은 훅이 실행됐다');
  assert.equal(c2.pushed, false, '.x(에이전트가 만든 git 흉내 폴더)는 범위 밖이라 푸시하지 않는다');
  assert.ok(c2.scope.violations.some((v) => v.path.startsWith('.x/')), JSON.stringify(c2.scope.violations));
  assert.ok(!c2.scope.violations.some((v) => v.path === '.git'), '.git은 가져오지 않는다');
  assert.ok(!fs.existsSync(path.join(h2.headWt, 'src', 'format.js')), '에이전트가 지운 파일은 HEAD worktree에서도 지워졌다');
  assert.ok(fs.existsSync(path.join(h2.headWt, 'src', 'types.js')), '손대지 않은 파일은 그대로');
  assert.equal(await remoteBranchSha(env.work, 'trio/a1/format'), c.sha, '원격은 그대로');
  // 심볼릭 링크 · 특수 파일은 따라가지 않고 위반
  fs.rmSync(path.join(h2.agentDir, '.x'), { recursive: true, force: true });
  fs.rmSync(path.join(h2.agentDir, '.git'), { force: true });
  let linked = true;
  try { fs.symlinkSync(os.homedir(), path.join(h2.agentDir, 'home-link'), 'junction'); } catch { linked = false; }
  if (linked) {
    const c3 = await ad.collect({ ...h2, collected: null }, { checkScope: scopeOf });
    assert.equal(c3.pushed, false);
    assert.deepEqual(c3.scope.violations, [{ path: 'home-link', rule: 'symlink' }]);
    // 링크 자체만 지운다(따라가 지우지 않게 rm -r을 쓰지 않는다)
    try { fs.unlinkSync(path.join(h2.agentDir, 'home-link')); } catch { fs.rmdirSync(path.join(h2.agentDir, 'home-link')); }
  }
  // L2: 원격이 그새 바뀌었으면 강제로 덮지 않는다(fast-forward만)
  await git(env.work, ['fetch', '--quiet', 'origin']);
  await git(env.work, ['checkout', '--quiet', '-B', 'other', c.sha]);
  writeFiles(env.work, { 'test/format.test.js': '// 다른 사람\n' });
  await git(env.work, ['add', '-A']);
  await git(env.work, ['commit', '--quiet', '-m', 'race']);
  await git(env.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/trio/a1/format']);
  const raced = (await git(env.work, ['rev-parse', 'HEAD'])).trim();
  await git(env.work, ['checkout', '--quiet', 'main']);
  writeFiles(h2.agentDir, pick(['src/format.js']));
  // HEAD worktree는 새 원격 끝에서 시작하므로 이번에는 그 위에 쌓인다 — 덮어쓰지 않는다
  const h4 = { ...h2, collected: null };
  const c4 = await ad.collect(h4, { checkScope: scopeOf });
  assert.equal(c4.pushed, true);
  assert.equal((await git(env.work, ['merge-base', '--is-ancestor', raced, c4.sha], { allowFail: true })) !== null, true, '남의 커밋을 지우지 않았다');
  await git(env.work, ['fetch', '--quiet', 'origin']);
  assert.equal(await git(env.work, ['show', `${c4.sha}:test/format.test.js`]), '// 다른 사람\n', '에이전트가 손대지 않은 파일은 원격 것 그대로(3방향)');
  // 같은 파일을 원격도 바꿨으면 덮지 않고 충돌
  await git(env.work, ['checkout', '--quiet', '-B', 'other2', c4.sha]);
  writeFiles(env.work, { 'README.md': '원격이 바꿈\n' });
  await git(env.work, ['commit', '--quiet', '-am', 'race2']);
  await git(env.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/trio/a1/format']);
  await git(env.work, ['checkout', '--quiet', 'main']);
  writeFiles(h2.agentDir, { 'README.md': '에이전트도 바꿈\n' });
  const c5 = await ad.collect({ ...h4, collected: null }, { checkScope: scopeOf });
  assert.equal(c5.pushed, false);
  assert.deepEqual(c5.scope.violations, [{ path: 'README.md', rule: 'conflict-with-remote' }]);
  // 검토 모드: 검토자 폴더가 바뀌면 changed
  const hr = await ad.start({ order: { id: 'format' }, branch: 'trio/a1/format', prompt: '검토', mode: 'review' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ad.poll(hr)).detail.changed, false);
  writeFiles(hr.agentDir, { 'src/format.js': '// 검토자가 고침\n' });
  assert.equal((await ad.poll(hr)).detail.changed, true);
});

test('H4: trio가 부르는 git은 저장소에 심은 훅 · fsmonitor를 돌리지 않는다', async () => {
  const env = await setupRepo({ 'README.md': 'x\n' });
  const marker = path.join(env.root, 'HOOK.txt');
  const hooks = path.join(env.work, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const script = `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`;
  for (const n of ['pre-commit', 'post-commit', 'commit-msg']) fs.writeFileSync(path.join(hooks, n), script, { mode: 0o755 });
  fs.writeFileSync(path.join(env.root, 'fsmon.sh'), script, { mode: 0o755 });
  await git(env.work, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
  await git(env.work, ['config', 'core.fsmonitor', path.join(env.root, 'fsmon.sh').replace(/\\/g, '/')]);
  writeFiles(env.work, { 'a.txt': 'a\n' });
  await git(env.work, ['add', '-A']);
  await git(env.work, ['commit', '--quiet', '-m', 'x']);
  await git(env.work, ['status', '--porcelain']);
  assert.ok(!fs.existsSync(marker), '훅 · fsmonitor가 돌았다');
});

