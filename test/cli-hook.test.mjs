// CLI(plan · approve · status · stop · init 점검) + 범위 훅 템플릿.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { git } from '../lib/gitops.mjs';
import { checkReady, formatReady } from '../bin/trio.mjs';
import { setupRepo, ROOT, calcPlan, writeFiles } from './helpers.mjs';

const TRIO = path.join(ROOT, 'bin', 'trio.mjs');
const HOOK = path.join(ROOT, 'templates', 'hooks', 'order-scope-guard.mjs');

function node(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const c = execFile(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    if (input !== undefined) c.stdin.end(input);
  });
}

test('CLI: plan(검증 · 승인 대기) → 승인 전 run 거부 → approve → stop → 재run 거부', async () => {
  const env = await setupRepo();
  const planPath = path.join(env.root, '계획 파일.json');
  const bad = calcPlan('cli1');
  bad.pieces[1].allowed_paths = ['src/add.js'];
  fs.writeFileSync(planPath, JSON.stringify(bad));
  let r = await node([TRIO, 'plan', '--file', planPath], { cwd: env.work });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /겹친다/);

  fs.writeFileSync(planPath, JSON.stringify(calcPlan('cli1')));
  r = await node([TRIO, 'plan', '--file', planPath], { cwd: env.work });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /승인 대기/);
  r = await node([TRIO, 'status', 'cli1'], { cwd: env.work });
  assert.match(r.stdout, /승인 대기/);

  r = await node([TRIO, 'run', 'cli1'], { cwd: env.work });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /승인이 없다/);
  assert.equal((await git(env.work, ['ls-remote', '--heads', 'origin', 'trio/*'])).trim(), '', '승인 전에는 브랜치도 만들지 않는다');

  r = await node([TRIO, 'approve', 'cli1'], { cwd: env.work });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /승인: cli1/);

  // L2: 위치 인자 <조각>도 형식을 본다(경로 조작 · 이상한 이름 거부)
  for (const bad of ['../x', 'A', 'a/b', '']) {
    r = await node([TRIO, 'relay', 'cli1', bad], { cwd: env.work });
    assert.notEqual(r.code, 0, bad);
    assert.match(r.stderr, /조각 이름/, bad);
  }
  r = await node([TRIO, 'review', 'cli1', '..'], { cwd: env.work });
  assert.match(r.stderr, /조각 이름/);
  r = await node([TRIO, 'lease', 'cli1', 'add'], { cwd: env.work });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--re/, '임대는 편지 이름이 있어야 한다');

  r = await node([TRIO, 'stop', 'cli1'], { cwd: env.work });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /STOPPED/);
  r = await node([TRIO, 'run', 'cli1'], { cwd: env.work });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /정지/);
  r = await node([TRIO, 'status', 'cli1'], { cwd: env.work });
  assert.match(r.stdout, /상태 STOPPED/);
  r = await node([TRIO, 'nope'], { cwd: env.work });
  assert.notEqual(r.code, 0);
});

test('P0 init 점검: 4항목 ✅/❌ + 빠진 항목의 고치는 법 + 공개 저장소 경고(가짜 exec — 실제 도구를 부르지 않는다)', async () => {
  const fake = (ok, extra = {}) => async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key in extra) return { stdout: extra[key] };
    if (ok.includes(cmd)) return { stdout: '1.0.0\n' };
    const e = new Error(`${cmd} 없음`);
    e.stderr = 'not found';
    throw e;
  };
  const all = await checkReady({
    exec: fake(['claude', 'codex', 'agy', 'gh', 'git'], { 'git remote get-url origin': 'https://github.com/someone/repo.git\n', 'gh repo view --json visibility -q .visibility': 'PUBLIC\n' }),
    config: { codex: { envId: 'env_1' } },
  });
  assert.equal(all.items.length, 4);
  assert.ok(all.items.every((i) => i.ok));
  const text = formatReady(all);
  assert.equal((text.match(/✅/g) || []).length, 4);
  assert.match(text, /공개 저장소다/);

  const none = await checkReady({ exec: fake(['git'], { 'git remote get-url origin': 'https://gitlab.com/x/y.git\n' }), config: {} });
  const t2 = formatReady(none);
  assert.equal((t2.match(/❌/g) || []).length, 4);
  assert.match(t2, /claude auth login/);
  assert.match(t2, /trio init --codex-env/);
  assert.match(t2, /agy/);
  assert.match(t2, /GitHub 저장소여야 한다/);
  assert.doesNotMatch(t2, /공개 저장소다/);

  const noEnv = await checkReady({ exec: fake(['claude', 'codex', 'agy', 'gh', 'git'], { 'git remote get-url origin': 'git@github.com:a/b.git\n', 'gh repo view --json visibility -q .visibility': 'PRIVATE\n' }), config: {} });
  assert.equal(noEnv.items.find((i) => i.name === 'Codex 웹').ok, false, '환경 ID가 없으면 ❌');
});

test('범위 훅: trio 조각 브랜치에서 allowed_paths 밖 편집 · 보호 경로는 종료 코드 2, ORDER가 없으면 통과', async () => {
  const env = await setupRepo({ 'README.md': 'x\n' });
  const run = (file, tool = 'Edit') => node([HOOK], { cwd: env.work, input: JSON.stringify({ tool_name: tool, tool_input: { file_path: file }, cwd: env.work }) });
  // trio 브랜치가 아니면 통과
  assert.equal((await run(path.join(env.work, 'anything.js'))).code, 0);

  await git(env.work, ['checkout', '--quiet', '-b', 'trio/r1/add']);
  // ORDER가 없으면 통과
  assert.equal((await run(path.join(env.work, 'anything.js'))).code, 0);
  writeFiles(env.work, { '.trio/orders/add.json': JSON.stringify({ allowed_paths: ['src/add.js', 'src/util/**'], protected_paths: ['src/types.js'] }) });
  const cases = [
    ['src/add.js', 0],
    ['src/util/깊은 폴더/x.js', 0],
    ['.trio/outbox/1.md', 0],
    ['src/mul.js', 2],
    ['src/Add.js', 2],
    ['src/types.js', 2],
    ['SRC/TYPES.js', 2],
    ['.trio/orders/add.json', 2],
    ['.env', 2],
    ['../밖.js', 2],
    ['.claude/settings.json', 2],
  ];
  for (const [rel, code] of cases) {
    const r = await run(path.join(env.work, rel));
    assert.equal(r.code, code, `${rel}: ${r.stderr}`);
    if (code === 2) assert.match(r.stderr, /trio 범위 훅/);
  }
  assert.equal((await run(path.join(env.work, 'src/mul.js'), 'Write')).code, 2);
  assert.equal((await run(path.join(env.work, 'src/mul.js'), 'Read')).code, 0, '편집 도구만 본다');
  // base · integration 브랜치는 조각이 아니다
  await git(env.work, ['checkout', '--quiet', '-b', 'trio/r1/integration']);
  assert.equal((await run(path.join(env.work, 'src/mul.js'))).code, 0);
});
