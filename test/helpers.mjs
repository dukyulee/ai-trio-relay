// 시험 공용: 한글 · 공백 경로의 임시 폴더, bare 원격 + 작업 clone, git 환경 격리, 계산기 예시 구현.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/gitops.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tempDir(prefix = '트리오 시험-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 사용자 전역 git 설정 · 훅에 기대지 않는다.
const isolated = tempDir('트리오 git설정-');
const globalCfg = path.join(isolated, 'gitconfig');
fs.writeFileSync(globalCfg, [
  '[user]', '\tname = trio-test', '\temail = trio-test',
  '[commit]', '\tgpgsign = false',
  '[core]', '\tautocrlf = false', `\thooksPath = ${path.join(isolated, 'no-hooks').replace(/\\/g, '/')}`,
  '[init]', '\tdefaultBranch = main',
  '[advice]', '\tdetachedHead = false',
  '',
].join('\n'));
process.env.GIT_CONFIG_GLOBAL = globalCfg;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.TRIO_HOME = path.join(isolated, 'trio-home');

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

export function readExample() {
  const base = path.join(ROOT, 'examples', 'calc');
  const files = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (n !== 'plan.json') files[path.relative(base, f).replace(/\\/g, '/')] = fs.readFileSync(f, 'utf8');
    }
  };
  walk(base);
  return files;
}

// bare 원격 + 작업 clone(main에 seed 커밋). push가 안 되면 시험이 의미 없으니 실패시킨다(건너뛰지 않는다).
export async function setupRepo(seed = readExample()) {
  const root = tempDir();
  const origin = path.join(root, 'origin.git');
  await git(root, ['init', '--quiet', '--bare', origin]);
  const work = path.join(root, '작업 clone');
  await git(root, ['clone', '--quiet', origin, work]);
  await git(work, ['checkout', '--quiet', '-B', 'main']);
  writeFiles(work, seed);
  await git(work, ['add', '-A']);
  await git(work, ['commit', '--quiet', '-m', 'seed']);
  try {
    await git(work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  } catch (err) {
    throw new Error(`bare 원격 push가 막혔다 — 이 환경에서는 시험이 의미 없다: ${err.message}`);
  }
  const check = await git(work, ['ls-remote', '--heads', 'origin', 'refs/heads/main']);
  if (!check.trim()) throw new Error('bare 원격에 main이 없다 — push 확인 실패');
  const runDir = path.join(root, 'run-dir');
  const agentsRoot = path.join(root, '에이전트 clone');
  fs.mkdirSync(agentsRoot, { recursive: true });
  return { root, origin, work, runDir, agentsRoot };
}

export const CALC = {
  'src/add.js': "import { assertNumber } from './types.js';\n\nexport function add(a, b) {\n  assertNumber(a, 'a');\n  assertNumber(b, 'b');\n  return a + b;\n}\n",
  'test/add.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n  assert.throws(() => add('2', 3), TypeError);\n});\n",
  'src/mul.js': "import { assertNumber } from './types.js';\n\nexport function mul(a, b) {\n  assertNumber(a, 'a');\n  assertNumber(b, 'b');\n  return a * b;\n}\n",
  'test/mul.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../src/mul.js';\n\ntest('mul', () => {\n  assert.equal(mul(2, 3), 6);\n});\n",
  'src/format.js': "import { PRECISION } from './types.js';\nimport { add } from './add.js';\nimport { mul } from './mul.js';\n\nexport const formatSum = (a, b) => add(a, b).toFixed(PRECISION);\nexport const formatProduct = (a, b) => mul(a, b).toFixed(PRECISION);\n",
  'test/format.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatSum, formatProduct } from '../src/format.js';\n\ntest('format', () => {\n  assert.equal(formatSum(1, 2), '3.00');\n  assert.equal(formatProduct(1.5, 2), '3.00');\n});\n",
};

export function calcPlan(run, overrides = {}) {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'calc', 'plan.json'), 'utf8'));
  plan.run = run;
  return { ...plan, ...overrides };
}

export const PASS_REVIEW = JSON.stringify({ verdict: 'PASS', findings: [] });

export async function waitFor(fn, { timeout = 30000, interval = 50, what = '조건' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`${what}을(를) ${timeout}ms 안에 못 봤다`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 가짜 어댑터 세 개. spec[agent] = { canPushMailbox, author, review }
export async function mockAdapters(env, runDir, spec = {}) {
  const { createMockAdapter } = await import('../lib/adapters/mock.mjs');
  const def = {
    claude: { canPushMailbox: true },
    codex: { canPushMailbox: false },
    antigravity: { canPushMailbox: false },
  };
  const out = {};
  for (const name of ['claude', 'codex', 'antigravity']) {
    const s = { ...def[name], ...(spec[name] || {}) };
    out[name] = createMockAdapter({
      name, originUrl: env.origin, workRoot: env.agentsRoot, runDir, canPushMailbox: s.canPushMailbox,
      scenarios: { author: s.author || implement(), review: s.review || (async () => ({ state: 'done', reviewText: PASS_REVIEW })) },
    });
  }
  return out;
}

// 기본 작성 시나리오: 자기 조각의 계산기 파일을 쓰고 커밋 · 푸시.
export function implement(extra = {}) {
  return async (ctx) => {
    const id = ctx.order.id;
    for (const [rel, c] of Object.entries(CALC)) {
      if (rel.includes(`/${id}.`)) ctx.write(rel, c);
    }
    for (const [rel, c] of Object.entries(extra)) ctx.write(rel, c);
    await ctx.commitPush();
    return { state: 'done' };
  };
}

export async function approved(env, plan) {
  const { preparePlan, approvePlan } = await import('../lib/run.mjs');
  const r = preparePlan({ runDir: env.runDir, plan, run: plan.run });
  if (!r.ok) throw new Error(r.errors.join(' / '));
  approvePlan(env.runDir);
}
