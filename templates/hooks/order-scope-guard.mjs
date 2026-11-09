#!/usr/bin/env node
// trio 범위 훅(Claude Code PreToolUse) — 대상 저장소의 .claude/hooks/에 복사해 쓴다. 의존성 없음(혼자 돈다).
// 지금 브랜치가 trio/<실행>/<조각>이면 .trio/orders/<조각>.json을 읽고, Edit · Write 대상이 allowed_paths 밖이면 종료 코드 2로 막는다.
// ORDER가 없으면 trio 브랜치가 아니므로 통과한다. 끝난 뒤 HEAD의 범위 검사가 한 번 더 본다(이 훅은 편집 순간의 첫 방어선).
//
// .claude/settings.json 예:
// {"hooks":{"PreToolUse":[{"matcher":"Edit|Write|MultiEdit|NotebookEdit","hooks":[{"type":"command","command":"node .claude/hooks/order-scope-guard.mjs"}]}]}}
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// lib/scope.mjs의 ALWAYS_PROTECTED + DEFAULT_PROTECTED와 같다(.trio/outbox/는 아래에서 먼저 허용).
const ALWAYS_PROTECTED = ['.trio/**', '.github/**', '.claude/**', '.gitmodules', '.gitattributes',
  '**/.env*', '**/.npmrc', '**/*.pem', '**/*.key', '**/*token*', '**/*secret*'];
const OUTBOX = '.trio/outbox/';

// lib/scope.mjs의 globToRegExp와 같은 규칙(** · * · ? · 끝의 /).
function globToRegExp(pattern, ignoreCase) {
  let p = String(pattern).replace(/\\/g, '/');
  if (p.endsWith('/')) p += '**';
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const segStart = i === 0 || p[i - 1] === '/';
        const segEnd = p[i + 2] === undefined || p[i + 2] === '/';
        if (segStart && segEnd) {
          if (p[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
          continue;
        }
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`, ignoreCase ? 'i' : '');
}
const matchAny = (list, p, ic) => list.some((g) => globToRegExp(g, ic).test(p));

function block(msg) {
  process.stderr.write(`trio 범위 훅: ${msg}\n`);
  process.exit(2);
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { block('훅 입력(JSON)을 읽지 못했다'); }
  const tool = input.tool_name || '';
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return;
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target) return;
  const cwd = input.cwd || process.cwd();
  let root;
  let branch;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    // git 저장소가 아니면 trio와 무관하다. 그 밖의 git 실패(잠금 · 부하 등)는 판단할 수 없으니 막는다(fail-closed).
    if (/not a git repository/i.test(String(err.stderr || err.message))) return;
    block(`git으로 브랜치를 확인하지 못했다 — 편집을 막는다(${String(err.message).split('\n')[0]})`);
  }
  const m = branch.match(/^trio\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/);
  if (!m || ['base', 'integration'].includes(m[2])) return;
  const orderFile = path.join(root, '.trio', 'orders', `${m[2]}.json`);
  if (!fs.existsSync(orderFile)) return;
  let order;
  try { order = JSON.parse(fs.readFileSync(orderFile, 'utf8')); } catch { block(`ORDER(${m[2]})를 읽지 못했다 — 편집을 막는다`); }

  const abs = path.resolve(cwd, target);
  const rel = path.relative(path.resolve(root), abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) block(`저장소 밖 파일이다: ${target}`);
  if (rel.startsWith(OUTBOX) && rel.length > OUTBOX.length) return; // 편지 자리
  const protectedPaths = [...ALWAYS_PROTECTED, ...(order.protected_paths || [])];
  if (matchAny(protectedPaths, rel, true)) block(`보호 경로라 고칠 수 없다: ${rel}`);
  if (!matchAny(order.allowed_paths || [], rel, false)) {
    block(`ORDER ${m[2]}의 allowed_paths 밖이다: ${rel}. 필요하면 HEAD에게 lease-request 편지를 보낸다.`);
  }
}

main();
