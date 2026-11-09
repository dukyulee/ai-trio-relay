// 범위 검사: base...조각 diff를 ORDER(allowed_paths · protected_paths · max_files · max_diff_lines)로 판정한다.
import { git, toGitPath } from './gitops.mjs';

// 어떤 ORDER에도 늘 들어가는 보호 경로. `.trio/outbox/`(편지 자리)는 보호보다 먼저 따로 허용한다.
export const ALWAYS_PROTECTED = ['.trio/**', '.trio/orders/**', '.trio/config.json'];
// 비밀값 · CI · 에이전트 설정 · 저장소 동작을 바꾸는 파일은 기본 보호.
export const DEFAULT_PROTECTED = [
  '.github/**', '.claude/**', '.gitmodules', '.gitattributes',
  '**/.env*', '**/.npmrc', '**/*.pem', '**/*.key', '**/*token*', '**/*secret*',
];
export const DEFAULT_MAX_BINARY_BYTES = 1024 * 1024;
export const OUTBOX_PREFIX = '.trio/outbox/';

// glob → 정규식. `**`는 '/'를 넘고, `*` · `?`는 넘지 않는다. 끝의 '/'는 폴더 전체를 뜻한다.
export function globToRegExp(pattern, { ignoreCase = false } = {}) {
  let p = toGitPath(pattern);
  if (p.endsWith('/')) p += '**';
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atSegStart = i === 0 || p[i - 1] === '/';
        const atSegEnd = p[i + 2] === undefined || p[i + 2] === '/';
        if (atSegStart && atSegEnd) {
          if (p[i + 2] === '/') {
            re += '(?:[^/]+/)*'; // `**/` = 0개 이상 폴더
            i += 2;
          } else {
            re += '.*'; // 끝의 `**` = 아래 전부
            i += 1;
          }
          continue;
        }
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re, ignoreCase ? 'i' : '');
}

export function matchGlob(pattern, filePath, opts) {
  return globToRegExp(pattern, opts).test(filePath);
}

export function matchAny(patterns, filePath, opts) {
  return patterns.some((p) => matchGlob(p, filePath, opts));
}

// 경로가 저장소 안 상대 경로로 바른지. '..' · 절대 경로 · 드라이브 문자 · 빈 조각 · 제어 문자는 거부.
export function invalidPathReason(p) {
  if (typeof p !== 'string' || p.length === 0) return 'empty';
  if (/[\u0000-\u001f]/.test(p)) return 'control-char';
  if (p.includes('\\')) return 'backslash';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return 'dot-dot';
  if (segs.some((s) => s === '' || s === '.')) return 'empty-segment';
  return null;
}

// changes: [{status:'A'|'M'|'D'|'R'|'C'|'T', path, oldPath?, added?, deleted?, mode?}]
// order: {allowed_paths, protected_paths, max_files, max_diff_lines}
// opts.excusedOrderPaths: HEAD가 직접 커밋한 ORDER 파일(임대 승인)이라 내용이 HEAD 사본과 같은 경로들
export function evaluateScope(changes, order, { contractPaths = [], excusedOrderPaths = [] } = {}) {
  const violations = [];
  const allowed = order.allowed_paths || [];
  const protectedPaths = [...ALWAYS_PROTECTED, ...DEFAULT_PROTECTED, ...contractPaths, ...(order.protected_paths || [])];
  let files = 0;
  let lines = 0;

  for (const ch of changes) {
    const paths = [ch.path];
    if ((ch.status === 'R') && ch.oldPath) paths.push(ch.oldPath);
    let counted = false;
    for (const raw of paths) {
      const p = raw;
      const bad = invalidPathReason(p);
      if (bad) {
        violations.push({ path: p, rule: `invalid-path:${bad}` });
        continue;
      }
      if (ch.mode === '120000') {
        violations.push({ path: p, rule: 'symlink' });
        continue;
      }
      if (ch.mode === '160000') {
        violations.push({ path: p, rule: 'submodule' });
        continue;
      }
      if (p === ch.path && ch.binary && (ch.size ?? Infinity) > (order.max_binary_bytes ?? DEFAULT_MAX_BINARY_BYTES)) {
        violations.push({ path: p, rule: `binary-too-large:${ch.size ?? '?'}` });
        continue;
      }
      // 작성자 편지 자리. 정확히 이 대소문자일 때만 허용하고, 병합 전에 빠진다.
      if (p.startsWith(OUTBOX_PREFIX) && p.length > OUTBOX_PREFIX.length && ch.status !== 'R') {
        continue;
      }
      if (excusedOrderPaths.includes(p) && ch.status === 'M') {
        continue;
      }
      // 보호 경로는 대소문자를 무시하고 비교한다(대소문자 무시 파일 시스템에서 같은 파일이다).
      if (matchAny(protectedPaths, p, { ignoreCase: true })) {
        const exact = matchAny(protectedPaths, p);
        violations.push({ path: p, rule: exact ? 'protected' : 'protected-case' });
        continue;
      }
      if (!matchAny(allowed, p)) {
        const caseOnly = matchAny(allowed, p, { ignoreCase: true });
        violations.push({ path: p, rule: caseOnly ? 'allowed-case' : 'outside-allowed' });
        continue;
      }
      counted = true;
    }
    if (counted) {
      files += 1;
      lines += (ch.added || 0) + (ch.deleted || 0);
    }
  }

  const maxFiles = order.max_files ?? Infinity;
  const maxLines = order.max_diff_lines ?? Infinity;
  if (files > maxFiles) violations.push({ path: '*', rule: `max-files:${files}>${maxFiles}` });
  if (lines > maxLines) violations.push({ path: '*', rule: `max-diff-lines:${lines}>${maxLines}` });
  return { ok: violations.length === 0, violations, files, lines };
}

// git diff --raw -z -M 출력 해석. name-status에 파일 모드(심볼릭 링크 · 서브모듈)가 더 붙은 형식이다.
export function parseRawZ(out) {
  const parts = out.split('\0');
  const res = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    if (!head.startsWith(':')) { i++; continue; }
    const [, newMode, , newSha, statusRaw] = head.slice(1).split(' ');
    const status = statusRaw[0];
    if (status === 'R' || status === 'C') {
      res.push({ status, oldPath: parts[i + 1], path: parts[i + 2], mode: newMode, newSha });
      i += 3;
    } else {
      res.push({ status, path: parts[i + 1], mode: status === 'D' ? null : newMode, newSha: status === 'D' ? null : newSha });
      i += 2;
    }
  }
  return res;
}

// git diff --numstat -z -M 출력 해석.
export function parseNumstatZ(out) {
  const parts = out.split('\0');
  const res = new Map();
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    const m = head.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) { i++; continue; }
    const binary = m[1] === '-';
    const added = binary ? 0 : Number(m[1]);
    const deleted = m[2] === '-' ? 0 : Number(m[2]);
    if (m[3] === '') {
      res.set(parts[i + 2], { added, deleted, binary });
      i += 3;
    } else {
      res.set(m[3], { added, deleted, binary });
      i += 1;
    }
  }
  return res;
}

export async function diffChanges(repoDir, base, head) {
  const range = `${base}...${head}`;
  const raw = await git(repoDir, ['-c', 'core.quotePath=false', 'diff', '--raw', '--no-abbrev', '-z', '-M', '--no-color', range]);
  const num = await git(repoDir, ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '-M', '--no-color', range]);
  const stats = parseNumstatZ(num);
  const out = parseRawZ(raw).map((c) => ({ ...c, ...(stats.get(c.path) || { added: 0, deleted: 0, binary: false }) }));
  // 바이너리는 줄 수가 없으니 크기로 본다.
  for (const c of out) {
    if (c.binary && c.newSha && !/^0+$/.test(c.newSha)) {
      const size = await git(repoDir, ['cat-file', '-s', c.newSha], { allowFail: true });
      c.size = size === null ? Infinity : Number(size.trim());
    }
  }
  return out;
}

// 실제 브랜치 검사. headOrderJson: HEAD가 가진 이 조각 ORDER(JSON 문자열) — 브랜치의 ORDER 파일이 이것과 똑같을 때만 바뀐 것을 봐준다.
export async function checkScope({ repoDir, base, head, order, contractPaths = [], headOrderJson, orderFile }) {
  const changes = await diffChanges(repoDir, base, head);
  const excused = [];
  if (orderFile && headOrderJson !== undefined && changes.some((c) => c.path === orderFile)) {
    const onBranch = await git(repoDir, ['show', `${head}:${orderFile}`], { allowFail: true });
    if (onBranch !== null && onBranch === headOrderJson) excused.push(orderFile);
  }
  return { ...evaluateScope(changes, order, { contractPaths, excusedOrderPaths: excused }), changes };
}
