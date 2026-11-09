// 전달함: 편지 형식 · 비밀값 거부 · 읽음 기록(이름 집합) · 결정 게시판 · P4 동시 푸시 100회.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Mailbox, formatLetter, parseLetter, validateLetter, findSecret, letterName, NAME_RE, MAILBOX_BRANCH } from '../lib/mailbox.mjs';
import { git, listTree } from '../lib/gitops.mjs';
import { setupRepo } from './helpers.mjs';

const J = (...p) => p.join('');
const base = { from: 'claude', to: 'codex', type: 'question', re: '', needs_reply: true, order: 'add', body: '형식이 뭐야?' };

test('편지 형식: 머리말 + 본문 왕복', () => {
  const t = formatLetter(base);
  assert.ok(t.startsWith('---\nfrom: claude\nto: codex\ntype: question\nre: \nneeds_reply: true\norder: add\n---\n'));
  assert.deepEqual(parseLetter(t), base);
  assert.throws(() => parseLetter('본문만'), /머리말/);
  assert.throws(() => parseLetter('---\nfrom: a\nevil: x\n---\n'), /모르는 머리말/);
});

test('편지 검증: 형식 · 4KB · 비밀값 패턴은 거부', () => {
  assert.deepEqual(validateLetter(base), []);
  assert.ok(validateLetter({ ...base, type: 'order' }).length, 'type 목록 밖');
  assert.ok(validateLetter({ ...base, to: 'gemini' }).length, '참가자 밖');
  assert.ok(validateLetter({ ...base, to: 'claude' }).length, '자기 자신');
  assert.ok(validateLetter({ ...base, re: '../x.md' }).length, 're 형식');
  assert.ok(validateLetter({ ...base, order: 'a\nb' }).length, '머리말 줄바꿈');
  assert.ok(validateLetter({ ...base, body: '가'.repeat(1400) }).length, '4KB 초과(한글 3바이트)');
  // 가짜 비밀값은 실행 중에 이어 붙여 만든다(저장소 파일에 비밀값 모양 글을 남기지 않는다 — P10).
  const secrets = [
    J('sk-', 'ant-api03-', 'abcdefghijklmnopqrstuvwxyz'),
    J('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    J('AKIA', 'ABCDEFGHIJKLMNOP'),
    J('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'),
    J('api', '_key = "abcd1234efgh"'),
    J('API-KEY: ', 'zzzz9999zzzz'),
    J('password=', 'hunter2hunter2'),
  ];
  for (const s of secrets) {
    assert.ok(findSecret(s), `패턴 못 찾음: ${s}`);
    assert.ok(validateLetter({ ...base, body: `참고: ${s}` }).some((e) => e.includes('비밀값')), `거부 안 됨: ${s}`);
  }
  assert.equal(findSecret('토큰 이야기를 하자. api key는 쓰지 않는다.'), null);
});

test('편지 이름: UTC 밀리초 + 보낸이 + 랜덤 6자리, 겹치지 않는다', () => {
  const d = new Date(Date.UTC(2026, 10, 10, 1, 2, 3, 45));
  const n = letterName('codex', d);
  assert.match(n, /^20261110T010203045-codex-[0-9a-f]{6}\.md$/);
  assert.match(n, NAME_RE);
  const many = new Set(Array.from({ length: 500 }, () => letterName('head', d)));
  assert.ok(many.size >= 499);
});

test('보내기 · 읽음 기록 · 답장 · 결정 게시판(로컬 bare 원격)', async () => {
  const { work, root } = await setupRepo({ 'README.md': 'x\n' });
  let clock = Date.UTC(2026, 10, 10, 12, 0, 0, 0);
  const mb = new Mailbox({ repoDir: work, run: 'r1', worktreeDir: path.join(root, 'mb-head'), now: () => new Date(clock) });
  await mb.init();
  const q = await mb.send({ ...base });
  assert.match(q.name, NAME_RE);
  await assert.rejects(mb.send({ ...base, body: J('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789') }), /비밀값/);

  // 시계가 어긋난 편지: 늦은 시각 편지를 먼저 읽고, 이른 시각 이름의 편지가 나중에 와도 빠지지 않아야 한다.
  clock += 60000;
  const late = await mb.send({ ...base, body: '늦은 시각' });
  assert.deepEqual((await mb.readNew('codex')).map((l) => l.name), [q.name, late.name]);
  clock -= 120000;
  const early = await mb.send({ ...base, body: '이른 시각(시계 차이)' });
  assert.ok(early.name < late.name, '이름이 사전순으로 앞선다');
  const again = await mb.readNew('codex');
  assert.deepEqual(again.map((l) => l.name), [early.name], '「마지막 이름」 방식이면 이 편지를 놓친다');
  assert.deepEqual(await mb.readNew('codex'), [], '읽은 편지는 다시 새 편지가 아니다');

  const ans = await mb.reply({ ...q }, { from: 'codex', body: 'JSON이다' });
  const box = await mb.list('claude');
  assert.equal(box.length, 1);
  assert.equal(box[0].type, 'answer');
  assert.equal(box[0].re, q.name);
  assert.equal(box[0].name, ans.name);

  await mb.appendDecision('계약 고정 abc');
  await mb.appendDecision('임대 승인 add ← src/x.js');
  const dec = await mb.readDecisions();
  assert.equal(dec.length, 2);
  assert.match(dec[1], /임대 승인/);
  await assert.rejects(mb.appendDecision('두\n줄'), /한 줄/);

  // 전달함은 코드 없는 orphan 브랜치다.
  const files = await listTree(work, `origin/${MAILBOX_BRANCH}`);
  assert.ok(files.every((f) => f === 'README.md' || f.startsWith('runs/r1/')), files.join(','));
  const mainSha = (await git(work, ['rev-parse', 'origin/main'])).trim();
  const mbRoot = (await git(work, ['rev-list', '--max-parents=0', `origin/${MAILBOX_BRANCH}`])).trim();
  assert.notEqual(mbRoot, mainSha);
  const mergeBase = await git(work, ['merge-base', 'origin/main', `origin/${MAILBOX_BRANCH}`], { allowFail: true });
  assert.equal(mergeBase, null, 'main과 공통 조상이 없다');
});

test('P4: 두 에이전트가 같은 순간 100회씩 푸시해도 편지 손실 0', async () => {
  const { origin, root, work } = await setupRepo({ 'README.md': 'x\n' });
  const head = new Mailbox({ repoDir: work, run: 'p4', worktreeDir: path.join(root, 'mb-head') });
  await head.init();
  const cloneA = path.join(root, 'clone A');
  const cloneB = path.join(root, 'clone B');
  await git(root, ['clone', '--quiet', origin, cloneA]);
  await git(root, ['clone', '--quiet', origin, cloneB]);
  const a = new Mailbox({ repoDir: cloneA, run: 'p4', worktreeDir: path.join(root, 'mb-a') });
  const b = new Mailbox({ repoDir: cloneB, run: 'p4', worktreeDir: path.join(root, 'mb-b') });
  const N = 100;
  const sent = { a: [], b: [] };
  // 둘이 매 회 같은 순간에 출발하게 맞춘다.
  for (let i = 0; i < N; i++) {
    const [x, y] = await Promise.all([
      a.send({ from: 'claude', to: 'codex', type: 'fyi', needs_reply: false, order: 'x', body: `a${i}` }),
      b.send({ from: 'antigravity', to: 'codex', type: 'fyi', needs_reply: false, order: 'y', body: `b${i}` }),
    ]);
    sent.a.push(x.name);
    sent.b.push(y.name);
  }
  const box = await head.list('codex');
  const names = new Set(box.map((l) => l.name));
  const lost = [...sent.a, ...sent.b].filter((n) => !names.has(n));
  assert.equal(lost.length, 0, `잃은 편지 ${lost.length}통`);
  assert.equal(box.length, 2 * N);
  const bodies = new Set(box.map((l) => l.body));
  for (let i = 0; i < N; i++) assert.ok(bodies.has(`a${i}`) && bodies.has(`b${i}`), `본문 ${i}`);
});
