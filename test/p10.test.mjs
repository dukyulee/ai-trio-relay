// P10 자동 검사: 저장소 파일 전체에 비밀값 · 이 PC 경로 · 실제 모양의 세션 ID가 없다. README · LICENSE 요건.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../lib/gitops.mjs';
import { findSecret } from '../lib/mailbox.mjs';
import { ROOT } from './helpers.mjs';

async function repoFiles() {
  const out = await git(ROOT, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.split('\0').filter((f) => f && !f.startsWith('.omc/') && fs.existsSync(path.join(ROOT, f)));
}

test('P10: 저장소 파일에 비밀값 · 개인 경로 · 세션 ID가 없다', async () => {
  const files = await repoFiles();
  assert.ok(files.length > 30, `파일 ${files.length}개`);
  const home = os.homedir();
  const user = path.basename(home);
  const forbidden = [home, home.replace(/\\/g, '/'), `/Users/${user}`, `/home/${user}`, os.tmpdir()].filter((x) => x.length > 3);
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    if (buf.includes(0)) continue; // 바이너리
    const text = buf.toString('utf8');
    const secret = findSecret(text);
    if (secret) hits.push(`${f}: 비밀값 패턴 ${secret}`);
    for (const p of forbidden) if (text.toLowerCase().includes(p.toLowerCase())) hits.push(`${f}: 개인 경로 ${p}`);
    if (/\b[A-Z]:[\\/](?:Users|2026)/i.test(text.replace(/\\\\/g, '\\'))) hits.push(`${f}: 드라이브 절대 경로`);
    if (/\bsession_[0-9A-Za-z]{20,}\b|\btask_e_[0-9a-f]{20,}\b/.test(text)) hits.push(`${f}: 실제 모양의 세션 · 작업 ID`);
    if (/[A-Za-z0-9._%+-]+@(?!github\.com)[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text)) hits.push(`${f}: 이메일 모양`);
  }
  assert.deepEqual(hits, []);
});

test('P10: README에 준비 · 설치 · 사용법 · 한계 · 공개 저장소 경고, LICENSE는 MIT', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const h of ['## 준비', '## 설치', '## 사용법', '## 한계']) assert.ok(readme.includes(h), h);
  assert.match(readme, /공개 저장소에서 쓰면 전달함 브랜치와 작업 브랜치도 공개된다/);
  assert.match(readme, /branches-ignore/);
  assert.match(readme, /브랜치 보호/);
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /MIT License/);
});
