// P8: 범위 시험 세트(20경우 이상) + 실제 git diff(이름 변경 · 한글 경로) 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateScope, globToRegExp, matchGlob, checkScope, parseRawZ, parseNumstatZ, ALWAYS_PROTECTED, DEFAULT_PROTECTED } from '../lib/scope.mjs';
import { git } from '../lib/gitops.mjs';
import { setupRepo, writeFiles, ROOT } from './helpers.mjs';

const ORDER = {
  allowed_paths: ['src/add.js', 'test/add.test.js', 'src/util/**', 'docs/*.md', 'lib/?.js'],
  protected_paths: ['src/types.js'],
  max_files: 5,
  max_diff_lines: 100,
};
const opts = { contractPaths: ['src/types.js'] };

// [이름, 변경 목록, 기대 ok, 기대 규칙(위반이면)]
const CASES = [
  ['허용 파일 추가', [{ status: 'A', path: 'src/add.js', added: 5 }], true],
  ['허용 파일 수정', [{ status: 'M', path: 'test/add.test.js', added: 1, deleted: 1 }], true],
  ['허용 밖 파일 추가', [{ status: 'A', path: 'src/mul.js', added: 3 }], false, 'outside-allowed'],
  ['허용 밖 파일 삭제', [{ status: 'D', path: 'src/mul.js', deleted: 3 }], false, 'outside-allowed'],
  ['허용 → 밖으로 이름 변경(새 경로)', [{ status: 'R', oldPath: 'src/add.js', path: 'src/mul.js' }], false, 'outside-allowed'],
  ['밖 → 허용으로 이름 변경(옛 경로)', [{ status: 'R', oldPath: 'src/mul.js', path: 'src/add.js' }], false, 'outside-allowed'],
  ['계약 파일 수정', [{ status: 'M', path: 'src/types.js', added: 1 }], false, 'protected'],
  ['계약 파일을 허용으로 이름 변경', [{ status: 'R', oldPath: 'src/types.js', path: 'src/add.js' }], false, 'protected'],
  ['ORDER 파일 자체 수정', [{ status: 'M', path: '.trio/orders/add.json', added: 1 }], false, 'protected'],
  ['ORDER 파일 새로 추가', [{ status: 'A', path: '.trio/orders/evil.json', added: 1 }], false, 'protected'],
  ['trio 설정 수정', [{ status: 'M', path: '.trio/config.json', added: 1 }], false, 'protected'],
  ['.. 경로', [{ status: 'A', path: 'src/../src/types.js' }], false, 'invalid-path:dot-dot'],
  ['절대 경로', [{ status: 'A', path: '/etc/passwd' }], false, 'invalid-path:absolute'],
  ['역슬래시 경로', [{ status: 'A', path: 'src\\add.js' }], false, 'invalid-path:backslash'],
  ['대소문자만 다른 계약 파일', [{ status: 'M', path: 'SRC/Types.js' }], false, 'protected-case'],
  ['대소문자만 다른 ORDER 폴더', [{ status: 'A', path: '.TRIO/Orders/add.json' }], false, 'protected-case'],
  ['대소문자만 다른 허용 파일', [{ status: 'A', path: 'src/Add.js' }], false, 'allowed-case'],
  ['하위 폴더 glob ** 허용', [{ status: 'A', path: 'src/util/deep/x.js', added: 2 }], true],
  ['* 는 폴더를 넘지 않는다', [{ status: 'A', path: 'docs/a/b.md' }], false, 'outside-allowed'],
  ['* 한 단계 허용', [{ status: 'A', path: 'docs/guide.md', added: 1 }], true],
  ['? 는 한 글자', [{ status: 'A', path: 'lib/ab.js' }], false, 'outside-allowed'],
  ['outbox 편지 허용', [{ status: 'A', path: '.trio/outbox/1.md', added: 9 }], true],
  ['outbox 밖 숨은 파일(.trio 아래)', [{ status: 'A', path: '.trio/outbox2/1.md' }], false, 'protected'],
  ['outbox 밖 숨은 파일(.github)', [{ status: 'A', path: '.github/workflows/x.yml' }], false, 'protected'],
  ['outbox 밖 숨은 파일(.claude 설정)', [{ status: 'A', path: '.claude/settings.json' }], false, 'protected'],
  ['대소문자 다른 outbox는 outbox가 아니다', [{ status: 'A', path: '.TRIO/outbox/1.md' }], false, 'protected-case'],
  ['outbox 로 이름 변경해 숨기기', [{ status: 'R', oldPath: 'src/mul.js', path: '.trio/outbox/x.md' }], false, 'outside-allowed'],
  ['.env 추가', [{ status: 'A', path: 'src/util/.env' }], false, 'protected'],
  ['토큰 파일', [{ status: 'A', path: 'src/util/my_token.txt' }], false, 'protected'],
  ['심볼릭 링크', [{ status: 'A', path: 'src/util/link', mode: '120000' }], false, 'symlink'],
  ['서브모듈', [{ status: 'A', path: 'src/util/sub', mode: '160000' }], false, 'submodule'],
  ['.gitmodules(허용 glob 밖이 아니어도 보호)', [{ status: 'A', path: '.gitmodules' }], false, 'protected'],
  ['.gitattributes', [{ status: 'M', path: '.gitattributes' }], false, 'protected'],
  ['하위 .npmrc', [{ status: 'A', path: 'src/util/.npmrc' }], false, 'protected'],
  ['인증서 .pem', [{ status: 'A', path: 'src/util/server.pem' }], false, 'protected'],
  ['키 파일 .key', [{ status: 'A', path: 'src/util/id.key' }], false, 'protected'],
  ['.env.local', [{ status: 'A', path: 'src/util/.env.local' }], false, 'protected'],
  ['.trio 아래 다른 파일', [{ status: 'A', path: '.trio/config2.json' }], false, 'protected'],
  ['큰 바이너리', [{ status: 'A', path: 'src/util/big.bin', binary: true, size: 2 * 1024 * 1024 }], false, 'binary-too-large:2097152'],
  ['크기 모르는 바이너리', [{ status: 'A', path: 'src/util/x.bin', binary: true }], false, 'binary-too-large:?'],
  ['max_files 초과', ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ status: 'A', path: `src/util/${n}.js`, added: 1 })), false, 'max-files:6>5'],
  ['max_diff_lines 초과', [{ status: 'A', path: 'src/add.js', added: 90 }, { status: 'M', path: 'test/add.test.js', added: 5, deleted: 6 }], false, 'max-diff-lines:101>100'],
  ['작은 바이너리는 허용', [{ status: 'A', path: 'src/util/logo.png', binary: true, size: 2048 }], true],
  ['outbox는 개수 상한에서 빠진다', [...['a', 'b', 'c', 'd', 'e'].map((n) => ({ status: 'A', path: `src/util/${n}.js`, added: 1 })), { status: 'A', path: '.trio/outbox/1.md', added: 50 }], true],
];

test('P8 범위 시험 세트: 20경우 이상이 모두 기대값', () => {
  assert.ok(CASES.length >= 20, `경우 ${CASES.length}개`);
  const rejectCases = CASES.filter((c) => !c[2]).length;
  assert.ok(rejectCases >= 20, `거부 경우 ${rejectCases}개 — 막혀야 하는 쪽을 충분히 단언한다`);
  for (const [name, changes, ok, rule] of CASES) {
    const r = evaluateScope(changes, ORDER, opts);
    assert.equal(r.ok, ok, `${name}: ok=${r.ok} ${JSON.stringify(r.violations)}`);
    if (!ok) assert.ok(r.violations.some((v) => v.rule === rule), `${name}: 규칙 ${rule} 기대, 실제 ${JSON.stringify(r.violations)}`);
  }
});

test('HEAD가 커밋한 ORDER(임대 승인)만 봐주고, 다른 ORDER 변경은 막는다', () => {
  const ch = [{ status: 'M', path: '.trio/orders/add.json', added: 1 }];
  assert.equal(evaluateScope(ch, ORDER, { excusedOrderPaths: ['.trio/orders/add.json'] }).ok, true);
  assert.equal(evaluateScope(ch, ORDER, { excusedOrderPaths: [] }).ok, false);
  assert.equal(evaluateScope([{ status: 'A', path: '.trio/orders/add.json' }], ORDER, { excusedOrderPaths: ['.trio/orders/add.json'] }).ok, false);
});

test('glob: ** · * · ? 경계', () => {
  assert.equal(matchGlob('src/**', 'src/a/b/c.js'), true);
  assert.equal(matchGlob('src/**', 'srcx/a.js'), false);
  assert.equal(matchGlob('**/*.md', 'a.md'), true);
  assert.equal(matchGlob('**/*.md', 'x/y/a.md'), true);
  assert.equal(matchGlob('src/*.js', 'src/a/b.js'), false);
  assert.equal(matchGlob('src/a?.js', 'src/ab.js'), true);
  assert.equal(matchGlob('src/a?.js', 'src/a/.js'), false);
  assert.equal(matchGlob('src/', 'src/x.js'), true);
  assert.equal(matchGlob('src/add.js', 'src/add.jsx'), false);
  assert.equal(matchGlob('a.b', 'aXb'), false, '. 은 글자 그대로');
  assert.equal(globToRegExp('src/a+b(c).js').test('src/a+b(c).js'), true);
});

test('raw · numstat -z 해석(이름 변경 · 공백 · 한글)', () => {
  const raw = ':100644 100644 aaa bbb R087\0옛 폴더/가.js\0새 폴더/나.js\0:000000 100644 000 ccc A\0문서 1.md\0';
  assert.deepEqual(parseRawZ(raw), [
    { status: 'R', oldPath: '옛 폴더/가.js', path: '새 폴더/나.js', mode: '100644', newSha: 'bbb' },
    { status: 'A', path: '문서 1.md', mode: '100644', newSha: 'ccc' },
  ]);
  const num = '1\t2\t\0옛 폴더/가.js\0새 폴더/나.js\0-\t-\t그림.png\0';
  const m = parseNumstatZ(num);
  assert.deepEqual(m.get('새 폴더/나.js'), { added: 1, deleted: 2, binary: false });
  assert.deepEqual(m.get('그림.png'), { added: 0, deleted: 0, binary: true });
});

test('실제 git diff: 이름 변경 양쪽 경로 · 한글 경로 · base...조각', async () => {
  const { work } = await setupRepo({ 'src/add.js': 'export const a = 1;\n'.repeat(5), 'src/types.js': 'export {};\n', '문서/설명 파일.md': '안녕\n' });
  await git(work, ['checkout', '--quiet', '-b', 'piece']);
  await git(work, ['mv', 'src/add.js', 'src/mul.js']);
  writeFiles(work, { '문서/설명 파일.md': '안녕\n하세요\n' });
  await git(work, ['commit', '--quiet', '-am', 'rename']);
  const order = { allowed_paths: ['src/add.js', '문서/설명 파일.md'], protected_paths: [] };
  const r = await checkScope({ repoDir: work, base: 'main', head: 'piece', order, contractPaths: ['src/types.js'] });
  assert.equal(r.ok, false);
  assert.ok(r.changes.some((c) => c.status === 'R' && c.oldPath === 'src/add.js' && c.path === 'src/mul.js'), JSON.stringify(r.changes));
  assert.deepEqual(r.violations, [{ path: 'src/mul.js', rule: 'outside-allowed' }]);
  // 허용 쪽 이름이면 통과(한글 · 공백 경로 수정 포함)
  const ok = await checkScope({ repoDir: work, base: 'main', head: 'piece', order: { allowed_paths: ['src/add.js', 'src/mul.js', '문서/**'] } });
  assert.equal(ok.ok, true, JSON.stringify(ok.violations));
});

test('M15: 범위 훅 템플릿의 보호 목록이 lib/scope.mjs와 같다', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'templates', 'hooks', 'order-scope-guard.mjs'), 'utf8');
  const m = hook.match(/const ALWAYS_PROTECTED = (\[[\s\S]*?\]);/);
  const list = JSON.parse(m[1].replace(/'/g, '"'));
  const lib = [...new Set([...ALWAYS_PROTECTED, ...DEFAULT_PROTECTED])].filter((p) => !['.trio/orders/**', '.trio/config.json'].includes(p));
  assert.deepEqual([...list].sort(), [...lib].sort());
});

test('L5: 실제 git diff에서 큰 바이너리는 크기로 막는다', async () => {
  const { work } = await setupRepo({ 'README.md': 'x\n' });
  await git(work, ['checkout', '--quiet', '-b', 'piece']);
  fs.writeFileSync(path.join(work, 'big.bin'), Buffer.alloc(1500, 0));
  await git(work, ['add', '-A']);
  await git(work, ['commit', '--quiet', '-m', 'bin']);
  const order = { allowed_paths: ['big.bin'], max_binary_bytes: 1000 };
  const r = await checkScope({ repoDir: work, base: 'main', head: 'piece', order });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [{ path: 'big.bin', rule: 'binary-too-large:1500' }]);
  assert.equal((await checkScope({ repoDir: work, base: 'main', head: 'piece', order: { ...order, max_binary_bytes: 2000 } })).ok, true);
});
