// 프로세스 사이 잠금: `trio run`과 `trio merge` · `trio mail send`가 같은 실행 · worktree를 동시에 쓰지 않게 한다.
// - 잠금 파일 = {pid, start(프로세스 시작 시각), nonce, at}. O_EXCL로 만든다.
// - 낡은 잠금(stale)은 「주인 PID가 죽었거나, 그 PID의 시작 시각이 기록과 다름(PID 재사용)」일 때만이다. 오래됐다는 이유로는 빼앗지 않는다.
// - 오래 쥐는 잠금은 주인이 주기적으로 at을 고친다(살아 있다는 표시 — 판단에는 쓰지 않는다).
// - 빼앗기는 원자적으로: 잠금 파일을 내 이름으로 rename → 옮긴 내용이 내가 낡았다고 본 그 잠금인지 다시 확인 → 아니면 되돌린다.
// - 풀 때는 파일 내용의 nonce가 내 것일 때만 지운다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { processInfo, isAlive } from './adapters/common.mjs';

export const REFRESH_MS = 60 * 1000;

let selfStart; // 이 프로세스의 시작 시각(한 번만 읽는다)
async function myStart() {
  if (selfStart === undefined) selfStart = (await processInfo(process.pid))?.start || null;
  return selfStart;
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 낡았는가: 주인이 죽었거나 PID가 다른 프로세스에 재사용됐을 때만 true. 판단할 수 없으면 false(빼앗지 않는다).
export async function isStaleLock(content, { infoOf = processInfo } = {}) {
  if (!content || !Number.isInteger(content.pid)) return false; // 막 만들어지는 중이거나 깨짐 — 기다린다
  if (!isAlive(content.pid)) return true;
  if (!content.start) return false;
  const now = await infoOf(content.pid);
  if (!now) return false;
  return now.start !== content.start;
}

// 같은 프로세스 안에서는 약속(Promise) 줄로 먼저 줄 세운다(중첩해서 잡지 않는다 — 같은 잠금을 안에서 다시 잡으면 멈춘다).
const queues = new Map();

export function withFileLock(file, fn, opts = {}) {
  const key = path.resolve(file).toLowerCase();
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(() => lockAndRun(file, fn, opts));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

// 낡은 잠금을 원자적으로 치운다. 다른 대기자가 먼저 치웠거나, 그새 새 주인이 생겼으면 false.
async function takeOver(file, judged) {
  const tmp = `${file}.take-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, tmp);
  } catch {
    return false; // 다른 대기자가 먼저 옮겼다
  }
  const moved = readLock(tmp);
  const same = judged === null ? moved === null : !!(moved && moved.nonce === judged.nonce);
  if (same) {
    fs.rmSync(tmp, { force: true });
    return true;
  }
  // 옮긴 것이 내가 낡았다고 본 잠금이 아니다(그새 새 주인) → 자리가 비어 있으면 되돌린다.
  try {
    fs.linkSync(tmp, file);
  } catch { /* 이미 다른 주인이 있다 — 그 주인이 우선 */ }
  fs.rmSync(tmp, { force: true });
  return false;
}

async function lockAndRun(file, fn, { timeoutMs = 120000, refreshMs = REFRESH_MS, infoOf = processInfo } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + timeoutMs;
  const mine = { pid: process.pid, start: await myStart(), nonce: crypto.randomBytes(16).toString('hex'), at: new Date().toISOString() };
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(mine));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readLock(file);
      if (held && held.nonce !== mine.nonce && await isStaleLock(held, { infoOf })) {
        await takeOver(file, held);
        continue;
      }
      // 만들다 죽어 내용이 빈 잠금: 10초 넘게 그대로면 치운다.
      if (!held) {
        let old = false;
        try { old = Date.now() - fs.statSync(file).mtimeMs > 10000; } catch { continue; }
        if (old) { await takeOver(file, null); continue; }
      }
      if (Date.now() > until) throw new Error(`잠금을 ${timeoutMs}ms 안에 얻지 못했다: ${path.basename(file)}`);
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 70));
    }
  }
  // 살아 있다는 표시를 주기적으로 고친다(내 잠금일 때만).
  const timer = setInterval(() => {
    const cur = readLock(file);
    if (!cur || cur.nonce !== mine.nonce) return;
    const tmp = `${file}.refresh-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...mine, at: new Date().toISOString() }));
      fs.renameSync(tmp, file);
    } catch { /* 다음 주기에 다시 */ }
  }, refreshMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    const cur = readLock(file);
    if (cur && cur.nonce === mine.nonce) fs.rmSync(file, { force: true });
  }
}
