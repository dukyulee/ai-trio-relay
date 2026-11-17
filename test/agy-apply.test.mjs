// agy 결과 3방향 적용(applyAgentChanges) — 3차 검수 중간-1.
// 「양쪽 다 지움」과 「중계가 지운 outbox 편지를 후속에서 다시 씀」은 합의, 그 밖의 원격 변경과 겹치면 충돌이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyAgentChanges, scanTree } from '../lib/adapters/antigravity-local.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// baseline(채운 순간) · 에이전트 폴더 · HEAD worktree(원격 끝)를 만든다
function setup({ base = {}, agent = {}, remote = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '트리오 적용 시험-'));
  const write = (dir, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  };
  const agentDir = path.join(root, 'agent');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(wt);
  write(agentDir, agent);
  write(wt, remote);
  const baseline = new Map(Object.entries(base).map(([rel, body]) => [rel, sha(body)]));
  const { files } = scanTree(agentDir);
  return { root, wt, files, baseline };
}

test('중간-1: 에이전트도 지우고 원격에도 없으면 충돌이 아니다', (t) => {
  const s = setup({ base: { 'src/old.js': 'a' }, agent: {}, remote: {} });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const r = applyAgentChanges(s.files, s.baseline, s.wt);
  assert.deepEqual(r.conflicts, []);
});

test('중간-1: 중계가 지운 outbox 편지를 후속 작업에서 같은 이름으로 다시 쓰면 새 편지로 받는다', (t) => {
  const s = setup({
    base: { '.trio/outbox/1.md': '첫 편지' },
    agent: { '.trio/outbox/1.md': '두 번째 편지' },
    remote: {},
  });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const r = applyAgentChanges(s.files, s.baseline, s.wt);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.readFileSync(path.join(s.wt, '.trio', 'outbox', '1.md'), 'utf8'), '두 번째 편지');
});

test('중간-1: 중계가 지운 outbox 편지를 에이전트도 지우면 충돌이 아니다', (t) => {
  const s = setup({ base: { '.trio/outbox/1.md': '첫 편지' }, agent: {}, remote: {} });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  assert.deepEqual(applyAgentChanges(s.files, s.baseline, s.wt).conflicts, []);
});

test('막혀야 하는 쪽: outbox 밖 파일을 원격이 지웠는데 에이전트가 고쳤으면 충돌이다', (t) => {
  const s = setup({ base: { 'src/a.js': 'v1' }, agent: { 'src/a.js': 'v2' }, remote: {} });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const r = applyAgentChanges(s.files, s.baseline, s.wt);
  assert.deepEqual(r.conflicts, [{ path: 'src/a.js', rule: 'conflict-with-remote' }]);
  assert.equal(fs.existsSync(path.join(s.wt, 'src', 'a.js')), false, '충돌이면 아무것도 얹지 않는다');
});

test('막혀야 하는 쪽: 원격과 에이전트가 같은 파일을 다르게 고쳤으면 충돌이다', (t) => {
  const s = setup({ base: { '.trio/orders/x.json': 'v1' }, agent: { '.trio/orders/x.json': 'agent' }, remote: { '.trio/orders/x.json': 'head' } });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const r = applyAgentChanges(s.files, s.baseline, s.wt);
  assert.equal(r.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(s.wt, '.trio', 'orders', 'x.json'), 'utf8'), 'head', 'HEAD 쪽을 덮지 않는다');
});

test('막혀야 하는 쪽: outbox 편지라도 원격에 다른 내용이 있으면 충돌이다', (t) => {
  const s = setup({ base: { '.trio/outbox/1.md': 'a' }, agent: { '.trio/outbox/1.md': 'b' }, remote: { '.trio/outbox/1.md': 'c' } });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  assert.equal(applyAgentChanges(s.files, s.baseline, s.wt).conflicts.length, 1);
});

test('원격이 기준 그대로면 에이전트 변경 · 삭제를 얹는다', (t) => {
  const s = setup({
    base: { 'src/a.js': 'v1', 'src/b.js': 'keep' },
    agent: { 'src/a.js': 'v2', 'src/new.js': 'n' },
    remote: { 'src/a.js': 'v1', 'src/b.js': 'keep' },
  });
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const r = applyAgentChanges(s.files, s.baseline, s.wt);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.readFileSync(path.join(s.wt, 'src', 'a.js'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(s.wt, 'src', 'new.js'), 'utf8'), 'n');
  assert.equal(fs.existsSync(path.join(s.wt, 'src', 'b.js')), false, '에이전트가 지운 파일은 지운다');
});
