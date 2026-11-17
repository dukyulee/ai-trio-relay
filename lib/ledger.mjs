// 로컬 실행 폴더(~/.trio/runs/<저장소>-<실행>/)와 원장(jsonl). 세션 ID · 링크는 여기에만 둔다(공개 저장소에 커밋 금지).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function trioHome() {
  return process.env.TRIO_HOME ? path.resolve(process.env.TRIO_HOME) : path.join(os.homedir(), '.trio');
}

// 실행 폴더 이름: <저장소 폴더>-<원격 URL 해시 8자>-<실행>. 같은 이름 폴더의 다른 저장소와 섞이지 않게.
export function runDirFor(repoDir, run, remoteUrl = '') {
  const repo = path.basename(path.resolve(repoDir)).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  const h = crypto.createHash('sha256').update(String(remoteUrl)).digest('hex').slice(0, 8);
  return path.join(trioHome(), 'runs', `${repo}-${h}-${run}`);
}



export function ensureRunDir(runDir) {
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'orders'), { recursive: true });
  return runDir;
}

export function appendLedger(runDir, entry) {
  ensureRunDir(runDir);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(runDir, 'ledger.jsonl'), `${line}\n`);
}

export function readLedger(runDir) {
  const f = path.join(runDir, 'ledger.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// 원자적 쓰기(임시 파일 → 이름 바꾸기).
// 실행 루프의 무결성 검사(guard)가 「HEAD가 방금 쓴 것」을 알 수 있게, 이 프로세스가 제어 파일을 쓸 때마다 알린다.
let controlWriteListener = null;
export function setControlWriteListener(fn) {
  controlWriteListener = fn;
}
export function notifyControlWrite(file) {
  if (controlWriteListener) controlWriteListener(file);
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
  notifyControlWrite(file);
}

export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 웹 세션 ID · 작업 ID · 로컬 프로세스 번호 표. `trio stop`이 다른 프로세스에서도 멈출 수 있게 남긴다.
export function recordSession(runDir, entry) {
  const f = path.join(runDir, 'sessions.json');
  const list = readJson(f, []);
  list.push({ at: new Date().toISOString(), ...entry });
  writeJson(f, list);
}

export function readSessions(runDir) {
  return readJson(path.join(runDir, 'sessions.json'), []);
}

export function saveRaw(runDir, name, text) {
  ensureRunDir(runDir);
  const f = path.join(runDir, 'logs', `${Date.now()}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`);
  fs.writeFileSync(f, String(text ?? ''));
  return f;
}
