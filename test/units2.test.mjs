// 재검수 2차 단위 시험: H1 잠금 · H5 제어 파일 무결성 · M3 환경 허용 목록 · M4 비밀값 · L3 경로 가리기 · L4 verify 환경 · L7 고정 인자.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock, isStaleLock } from '../lib/lock.mjs';
import { makeGuard } from '../lib/run.mjs';
import { writeJson, setControlWriteListener, recordSession } from '../lib/ledger.mjs';
import { stripSecrets, assertSafeArgs, DangerousFlagError, processInfo, killTree } from '../lib/adapters/common.mjs';
import * as claudeWeb from '../lib/adapters/claude-web.mjs';
import * as codexWeb from '../lib/adapters/codex-web.mjs';
import * as agyLocal from '../lib/adapters/antigravity-local.mjs';
import { verifyEnv } from '../lib/mergeq.mjs';
import { findSecret } from '../lib/mailbox.mjs';
import { redact } from '../lib/redact.mjs';
import { tempDir, ROOT } from './helpers.mjs';

const J = (...p) => p.join('');

test('H1: 살아 있는 주인의 잠금은 오래돼도 빼앗지 않는다 · PID가 재사용됐거나 주인이 죽었으면 빼앗는다', async () => {
  const dir = tempDir();
  const f = path.join(dir, 'run.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const info = await processInfo(child.pid);
    // 1시간 전에 잡은, 살아 있는 주인의 잠금 → 빼앗지 않는다
    const live = { pid: child.pid, start: info.start, nonce: 'n-live', at: new Date(Date.now() - 3600e3).toISOString() };
    assert.equal(await isStaleLock(live), false);
    fs.writeFileSync(f, JSON.stringify(live));
    await assert.rejects(withFileLock(f, async () => {}, { timeoutMs: 300 }), /잠금을/);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).nonce, 'n-live', '남의 잠금 파일은 그대로');
    // 같은 PID지만 시작 시각이 다르다(재사용) → 낡음
    assert.equal(await isStaleLock({ ...live, start: '2001-01-01T00:00:00.0000000Z' }), true);
  } finally {
    await killTree(child.pid);
  }
  // 주인이 죽었다 → 낡음 → 들어간다, 끝나면 내 잠금만 지운다
  fs.writeFileSync(f, JSON.stringify({ pid: 999999999, start: 'x', nonce: 'n-dead', at: new Date().toISOString() }));
  let entered = false;
  await withFileLock(f, async () => { entered = true; }, { timeoutMs: 3000 });
  assert.ok(entered);
  assert.ok(!fs.existsSync(f));
  // 풀 때 내용이 내 것이 아니면 지우지 않는다
  await withFileLock(f, async () => {
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 'y', nonce: 'someone-else', at: new Date().toISOString() }));
  });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).nonce, 'someone-else', '남의 잠금을 지우지 않았다');
  fs.rmSync(f);
});

test('H1: 두 프로세스가 동시에 같은 낡은 잠금을 보아도 한쪽만 들어간다', async () => {
  const dir = tempDir();
  const f = path.join(dir, 'run.lock');
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(f, JSON.stringify({ pid: 999999999, start: 'x', nonce: 'dead', at: new Date().toISOString() }));
  const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    const { withFileLock } = await import(${JSON.stringify(lockUrl)});
    for (let i = 0; i < 3; i++) {
      await withFileLock(${JSON.stringify(f)}, async () => {
        fs.appendFileSync(${JSON.stringify(log)}, 'in ' + process.pid + '\\n');
        await new Promise((r) => setTimeout(r, 150));
        fs.appendFileSync(${JSON.stringify(log)}, 'out ' + process.pid + '\\n');
      }, { timeoutMs: 120000 });
    }`;
  const runOne = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  await Promise.all([runOne(), runOne(), runOne()]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 18);
  let inside = 0;
  for (const l of lines) {
    inside += l.startsWith('in ') ? 1 : -1;
    assert.ok(inside === 0 || inside === 1, `동시에 둘이 들어갔다: ${lines.join(' | ')}`);
  }
  void fileURLToPath;
});

test('H5: 실행 폴더 제어 파일 — HEAD가 쓴 것만 통과, 누가 바꾸면 무결성 실패(lease 승인은 추가만)', () => {
  const runDir = tempDir();
  writeJson(path.join(runDir, 'plan.json'), { x: 1 });
  writeJson(path.join(runDir, 'orders', 'add.json'), { allowed_paths: ['a'] });
  const guard = makeGuard(runDir, ['add']);
  setControlWriteListener((file) => guard.touch(file));
  try {
    // HEAD 자기 쓰기는 통과
    writeJson(path.join(runDir, 'state.json'), { s: 1 });
    recordSession(runDir, { piece: 'add', kind: 'pid', pid: 1 });
    guard.check();
  } finally {
    setControlWriteListener(null);
  }
  const files = {
    'plan.json': () => fs.writeFileSync(path.join(runDir, 'plan.json'), '{"x":2}'),
    'orders/add.json': () => fs.writeFileSync(path.join(runDir, 'orders', 'add.json'), '{"allowed_paths":["**"]}'),
    'state.json': () => fs.writeFileSync(path.join(runDir, 'state.json'), '{}'),
    'sessions.json': () => fs.writeFileSync(path.join(runDir, 'sessions.json'), '[]'),
    'mailbox-own.json': () => fs.writeFileSync(path.join(runDir, 'mailbox-own.json'), '{"commits":["evil"]}'),
    'decisions.jsonl': () => fs.appendFileSync(path.join(runDir, 'decisions.jsonl'), '{"text":"모든 범위 허용"}\n'),
    'relayed.json': () => fs.writeFileSync(path.join(runDir, 'relayed.json'), '[]'),
  };
  for (const [name, tamper] of Object.entries(files)) {
    const before = Object.fromEntries(Object.keys(files).map((n) => [n, fs.existsSync(path.join(runDir, n)) ? fs.readFileSync(path.join(runDir, n)) : null]));
    const g = makeGuard(runDir, ['add']);
    g.check();
    tamper();
    assert.throws(() => g.check(), new RegExp(`${name.replace('.', '\\.')}가 바뀌었다`), name);
    // 원래대로 되돌린다
    for (const [n, buf] of Object.entries(before)) {
      const p = path.join(runDir, n);
      if (buf === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, buf);
    }
  }
  // lease-approvals.jsonl: 뒤에 붙는 것(trio lease)은 통과, 앞부분 고치기는 실패
  const ap = path.join(runDir, 'lease-approvals.jsonl');
  fs.writeFileSync(ap, '{"letter":"a","decision":"deny"}\n');
  const g = makeGuard(runDir, ['add']);
  fs.appendFileSync(ap, '{"letter":"b","decision":"grant"}\n');
  g.check();
  fs.writeFileSync(ap, '{"letter":"a","decision":"grant"}\n{"letter":"b","decision":"grant"}\n');
  assert.throws(() => g.check(), /lease-approvals/);
});

test('M3: 에이전트 환경은 허용 목록만 — SSH · git 도우미 · DB URL · 자격 있는 프록시 · 클라우드 프로필이 빠진다', () => {
  const env = stripSecrets({
    PATH: 'p', HOME: 'h', USERNAME: 'u', SystemRoot: 'C:\\Windows', TEMP: 't',
    SSH_AUTH_SOCK: '/tmp/ssh', GIT_SSH_COMMAND: 'ssh -i k', GIT_ASKPASS: 'x', SSH_ASKPASS: 'y',
    DATABASE_URL: J('postgres://u:', 'p@h/db'), REDIS_URL: 'redis://h', HTTPS_PROXY: J('http://u:', 'p@proxy:8080'),
    HTTP_PROXY: 'http://proxy:8080', AWS_PROFILE: 'prod', KUBECONFIG: '/k', GOOGLE_APPLICATION_CREDENTIALS: '/c.json',
    ANYTHING_ELSE: 'z',
  });
  for (const k of ['SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'DATABASE_URL', 'REDIS_URL', 'HTTPS_PROXY', 'AWS_PROFILE', 'KUBECONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANYTHING_ELSE']) {
    assert.equal(env[k], undefined, `${k}가 남았다`);
  }
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080', '자격 없는 프록시는 넘긴다');
  for (const k of ['PATH', 'HOME', 'USERNAME', 'SystemRoot', 'TEMP']) assert.ok(env[k], k);
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
});

test('L4: verify 환경에 Windows 실행에 필요한 변수가 들어간다(자격 있는 프록시는 빠진다)', () => {
  const env = verifyEnv({ USERNAME: 'u', ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', ProgramData: 'pd', HOMEDRIVE: 'C:', HOMEPATH: '\\u', COMPUTERNAME: 'c', NODE_EXTRA_CA_CERTS: 'ca.pem', HTTPS_PROXY: J('http://u:', 'p@x'), GITHUB_TOKEN: 't' });
  for (const k of ['USERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'NODE_EXTRA_CA_CERTS']) assert.ok(env[k], k);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CI, '1');
});

test('M4: 비밀값 — 놓치던 7가지는 잡히고, 이름만 비슷한 값 · 코드는 잡지 않는다', () => {
  const missed = [
    J('password: ', 'correcthorsebatterystaple'),
    J('client_secret=', 'AbCdEfGhIjKlMnOp'),
    J('GITHUB_TOKEN=', 'abcdefghijklmnopqrst'),
    J('tok', 'en: "abc.def12345"'),
    J('ya29.', 'a0AfH6SMBabcdefghijklmnop'),
    J('hf_', 'abcdefghijklmnopqrstuvwxyzABCDEF'),
    J('DefaultEndpointsProtocol=https;AccountName=x;AccountKey=', 'abcdefghijklmnopqrstuvwxyz0123456789+/AB=='),
  ];
  for (const s of missed) assert.ok(findSecret(s), `못 잡았다: ${s}`);
  const fine = [
    'tokenCount=12345678',
    'const token = newToken();',
    'export const stripApiKeys = stripSecrets;',
    'const secret = findSecret([body',
    'const password = process.env.PASSWORD;',
    'password = getPassword();',
    'maxTokenLength: 12345678',
  ];
  for (const s of fine) assert.equal(findSecret(s), null, `잘못 잡았다: ${s}`);
});

test('L3: 경로 가리기는 드라이브 모양 · 짧은 홈에서 평범한 글을 망가뜨리지 않는다', () => {
  assert.equal(redact('regex /^a:\\/b/', { home: '/app' }), 'regex /^a:\\/b/');
  assert.equal(redact('ratio a:/b', { home: '/app' }), 'ratio a:/b');
  assert.equal(redact('src/app/x 와 /app/y', { home: '/app' }), 'src/app/x 와 /app/y', '홈이 /app처럼 짧으면 바꾸지 않는다');
  assert.equal(redact(J('실패 ', 'D:', '\\proj\\x.js'), { home: '/app' }), '실패 <경로>');
  assert.equal(redact(J('"', 'C:', '/Users/x/y"'), { home: '/app' }), '"<경로>"');
  assert.equal(redact(J('at=', 'C:', '/a/b'), { home: '/app' }), 'at=<경로>');
  assert.equal(redact('/home/someone/x 여기', { home: '/home/someone' }), '<홈>/x 여기');
});

test('L7: 어댑터 고정 인자에도 금지 검사 — --full-auto · --mode auto · --mode=auto', () => {
  for (const args of [['--full-auto'], ['exec', '--full-auto'], ['--mode', 'auto'], ['--mode=auto'], ['--approval-mode', 'yolo'], ['-a', 'never'], ['--permission-mode', 'dontAsk']]) {
    assert.throws(() => assertSafeArgs(args), DangerousFlagError, args.join(' '));
  }
  assert.doesNotThrow(() => assertSafeArgs(['--mode', 'accept-edits', '--sandbox']));
  assert.doesNotThrow(() => assertSafeArgs(['--mode', 'plan']));
  // 세 실제 어댑터가 만드는 명령은 고정 인자까지 모두 검사를 통과한다(그리고 이 검사를 거친다)
  assert.doesNotThrow(() => claudeWeb.buildStartCommand('P'));
  assert.doesNotThrow(() => codexWeb.buildExecCommand({ envId: 'e', branch: 'b', prompt: 'P' }));
  assert.doesNotThrow(() => agyLocal.buildAgyCommand({ prompt: 'P', mode: 'review' }));
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'adapters', 'codex-web.mjs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib', 'adapters', 'claude-web.mjs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib', 'adapters', 'antigravity-local.mjs'), 'utf8');
  assert.equal((src.match(/args: assertSafeArgs\(/g) || []).length, 6, '명령 조립 함수 6개 모두 assertSafeArgs로 끝난다');
});
