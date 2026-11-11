// 실행 상태(state.json) · 정지 표시 · 하트비트 · `trio status` 표.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './ledger.mjs';

export const TERMINAL = ['MERGED', 'SCOPE_FAILED', 'REVIEW_FAILED', 'NEEDS_HUMAN', 'MERGE_CONFLICT', 'VERIFY_FAILED', 'DEP_FAILED', 'FAILED', 'LIMIT', 'STOPPED', 'PASSED',
  'NO_CHANGES', 'CHANGED_AFTER_SCOPE', 'CHANGED_AFTER_REVIEW', 'BASE_CHANGED', 'INTEGRATION_CHANGED', 'MERGE_ABORTED', 'NOT_REVIEWED', 'ABORTED'];

const stateFile = (runDir) => path.join(runDir, 'state.json');
const stopFile = (runDir) => path.join(runDir, 'STOPPED');

// 정지 표시는 따로 둔 파일이다. 다른 프로세스(`trio stop`)가 써도 실행 중인 루프가 덮어쓰지 못한다.
export function isStopped(runDir) {
  return fs.existsSync(stopFile(runDir));
}

export function markStopped(runDir, reason = '') {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(stopFile(runDir), `${new Date().toISOString()} ${reason}\n`);
}

export function loadState(runDir) {
  const s = readJson(stateFile(runDir), null);
  if (!s) return null;
  if (isStopped(runDir)) s.status = 'STOPPED';
  return s;
}

export function saveState(runDir, state) {
  const s = { ...state, updatedAt: new Date().toISOString() };
  if (isStopped(runDir)) s.status = 'STOPPED';
  writeJson(stateFile(runDir), s);
  return s;
}

export function updatePiece(runDir, state, id, patch) {
  state.pieces[id] = { ...state.pieces[id], ...patch, lastSignal: patch.lastSignal ?? new Date().toISOString() };
  return saveState(runDir, state);
}

function ago(iso, now) {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

// 조각마다 상태 · 마지막 신호 · 링크 · 마지막 편지. N분 동안 신호가 없으면 「멈춤」.
export function formatStatus(state, { heartbeats = {}, now = Date.now(), stallMinutes = 30 } = {}) {
  if (!state) return '실행 기록이 없다.';
  const rows = [['조각', '에이전트', '상태', '마지막 신호', '검토자', '링크', '마지막 편지']];
  for (const [id, p] of Object.entries(state.pieces || {})) {
    const hb = heartbeats[p.agent];
    // 하트비트는 HEAD가 받은 시각(receivedAt)으로 본다. 에이전트가 적은 시각은 믿지 않는다.
    const signals = [p.lastSignal, hb && hb.order === id ? hb.receivedAt : null].filter(Boolean).sort();
    const last = signals[signals.length - 1];
    let st = p.state || '-';
    if (!TERMINAL.includes(st) && last && now - Date.parse(last) > stallMinutes * 60000) st = `${st}(멈춤)`;
    rows.push([id, p.agent, st, ago(last, now), p.reviewer || '-', p.link || '-', p.lastLetter || '-']);
  }
  const width = rows[0].map((_, c) => Math.max(...rows.map((r) => displayWidth(String(r[c])))));
  const line = (r) => r.map((v, c) => pad(String(v), width[c])).join(' │ ');
  const out = [`실행 ${state.run} · 상태 ${state.status}${state.approved ? '' : ' · 승인 대기'}`, line(rows[0]), width.map((w) => '─'.repeat(w)).join('─┼─')];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join('\n');
}

// 한글은 터미널에서 두 칸을 쓴다.
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, w) {
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}
