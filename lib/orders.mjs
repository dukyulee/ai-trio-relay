// plan.json 검증 · ORDER 만들기 · 임대 승인.
import crypto from 'node:crypto';
import { ALWAYS_PROTECTED, DEFAULT_PROTECTED, invalidPathReason, matchAny, globToRegExp } from './scope.mjs';

export const AGENTS = ['claude', 'codex', 'antigravity'];
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RESERVED_IDS = ['base', 'integration', 'mailbox'];
export const DEFAULT_MAX_FILES = 20;
export const DEFAULT_MAX_DIFF_LINES = 800;
export const DEFAULT_MAX_PIECES = 3;

export function orderPath(id) {
  return `.trio/orders/${id}.json`;
}

export function branchNames(run, id) {
  return {
    base: `trio/${run}/base`,
    integration: `trio/${run}/integration`,
    piece: id ? `trio/${run}/${id}` : undefined,
  };
}

export function planHash(plan) {
  return crypto.createHash('sha256').update(stableStringify(plan)).digest('hex');
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function literalPrefix(p) {
  const i = p.search(/[*?]/);
  return i < 0 ? p : p.slice(0, i);
}
function literalSuffix(p) {
  const m = p.match(/[*?]([^*?]*)$/);
  return m ? m[1] : p;
}
function hasGlob(p) {
  return /[*?]/.test(p);
}

// 두 glob이 같은 파일을 가리킬 수 있는지(보수적으로 — 애매하면 겹친다고 본다). 대소문자 무시.
export function patternsOverlap(a, b) {
  const A = a.toLowerCase().replace(/\/$/, '/**');
  const B = b.toLowerCase().replace(/\/$/, '/**');
  if (!hasGlob(A) && !hasGlob(B)) return A === B;
  if (!hasGlob(A)) return globToRegExp(B).test(A);
  if (!hasGlob(B)) return globToRegExp(A).test(B);
  const pa = literalPrefix(A), pb = literalPrefix(B);
  const sa = literalSuffix(A), sb = literalSuffix(B);
  const prefixOk = pa.startsWith(pb) || pb.startsWith(pa);
  const suffixOk = sa.endsWith(sb) || sb.endsWith(sa);
  return prefixOk && suffixOk;
}

function validateCommand(v, where, errors) {
  if (typeof v === 'string') {
    if (!v.trim()) errors.push(`${where}: verify 명령이 비었다`);
  } else if (Array.isArray(v)) {
    if (v.length === 0 || v.some((x) => typeof x !== 'string' || !x)) errors.push(`${where}: verify 배열은 빈칸 없는 문자열이어야 한다`);
  } else if (v !== undefined) {
    errors.push(`${where}: verify는 문자열이나 문자열 배열이다`);
  }
}

function validatePatterns(list, where, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${where}: 배열이어야 한다`);
    return;
  }
  for (const p of list) {
    const bad = typeof p === 'string' ? invalidPathReason(p.replace(/\/$/, '')) : 'not-string';
    if (bad) errors.push(`${where}: 경로 "${p}"가 바르지 않다(${bad})`);
  }
}

// 순환 검사 + 의존 순서(위상 정렬). 순환이 있으면 null.
export function topoOrder(pieces) {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const out = [];
  const mark = new Map();
  const visit = (id) => {
    const m = mark.get(id);
    if (m === 'done') return true;
    if (m === 'doing') return false;
    mark.set(id, 'doing');
    for (const d of byId.get(id)?.deps || []) {
      if (byId.has(d) && !visit(d)) return false;
    }
    mark.set(id, 'done');
    out.push(byId.get(id));
    return true;
  };
  for (const p of pieces) if (!visit(p.id)) return null;
  return out;
}

export function validatePlan(plan, { maxPieces = DEFAULT_MAX_PIECES } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan이 객체가 아니다'] };
  if (plan.run !== undefined && !ID_RE.test(plan.run)) errors.push(`run "${plan.run}" 형식이 바르지 않다(${ID_RE})`);
  if (plan.base !== undefined && !isBranchName(plan.base)) errors.push(`base "${plan.base}"가 브랜치 이름 형식이 아니다`);
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) errors.push('goal(목표 한 줄)이 없다');
  validateCommand(plan.verify, 'plan', errors);
  if (plan.verify === undefined) errors.push('plan: 전체 verify 명령이 없다');
  const contract = plan.contract || {};
  validatePatterns(contract.paths || [], 'contract.paths', errors);
  if (contract.files !== undefined) {
    if (typeof contract.files !== 'object' || Array.isArray(contract.files)) errors.push('contract.files는 {경로: 내용} 객체다');
    else for (const [p, c] of Object.entries(contract.files)) {
      if (invalidPathReason(p)) errors.push(`contract.files 경로 "${p}"가 바르지 않다`);
      if (typeof c !== 'string') errors.push(`contract.files["${p}"] 내용은 문자열이다`);
      if (!(contract.paths || []).includes(p)) errors.push(`contract.files["${p}"]는 contract.paths에도 있어야 한다`);
    }
  }
  if (plan.protected_paths !== undefined) validatePatterns(plan.protected_paths, 'protected_paths', errors);

  const pieces = plan.pieces;
  if (!Array.isArray(pieces) || pieces.length === 0) {
    errors.push('pieces가 비었다');
    return { ok: false, errors };
  }
  if (pieces.length > maxPieces) errors.push(`조각이 ${pieces.length}개 — 상한 ${maxPieces}개`);
  const ids = new Set();
  for (const [i, p] of pieces.entries()) {
    const where = `pieces[${i}]${p && p.id ? `(${p.id})` : ''}`;
    if (!p || typeof p !== 'object') { errors.push(`${where}: 객체가 아니다`); continue; }
    if (!ID_RE.test(p.id || '')) errors.push(`${where}: id 형식이 바르지 않다(${ID_RE})`);
    else if (RESERVED_IDS.includes(p.id)) errors.push(`${where}: id "${p.id}"는 예약어다`);
    else if (ids.has(p.id)) errors.push(`${where}: id가 겹친다`);
    ids.add(p.id);
    if (!AGENTS.includes(p.agent)) errors.push(`${where}: agent는 ${AGENTS.join(' · ')} 중 하나다`);
    if (typeof p.goal !== 'string' || !p.goal.trim()) errors.push(`${where}: goal이 없다`);
    validatePatterns(p.allowed_paths, `${where}.allowed_paths`, errors);
    if (Array.isArray(p.allowed_paths) && p.allowed_paths.length === 0) errors.push(`${where}: allowed_paths가 비었다`);
    if (p.protected_paths !== undefined) validatePatterns(p.protected_paths, `${where}.protected_paths`, errors);
    validateCommand(p.verify, where, errors);
    if (p.deps !== undefined && !Array.isArray(p.deps)) errors.push(`${where}: deps는 배열이다`);
    for (const k of ['max_files', 'max_diff_lines']) {
      if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] > 0)) errors.push(`${where}: ${k}는 양의 정수다`);
    }
    // 허용 경로가 계약 · 늘 보호 경로와 겹치면 계획 단계에서 막는다.
    for (const a of p.allowed_paths || []) {
      for (const g of [...ALWAYS_PROTECTED, ...(contract.paths || [])]) {
        if (typeof a === 'string' && patternsOverlap(a, g) && !hasGlob(a)) errors.push(`${where}: "${a}"는 보호 경로 "${g}"다`);
      }
    }
  }
  // 한 에이전트에 조각 하나: 상자 · 하트비트 · 검토자 돌려 막기가 에이전트 단위라 둘이면 섞인다.
  const byAgent = new Map();
  for (const p of pieces) {
    if (!p || !AGENTS.includes(p.agent)) continue;
    if (byAgent.has(p.agent)) errors.push(`${p.agent}에 조각이 둘이다(${byAgent.get(p.agent)} · ${p.id}) — 에이전트당 조각 1개`);
    else byAgent.set(p.agent, p.id);
  }
  for (const p of pieces) {
    for (const d of p.deps || []) {
      if (!ids.has(d)) errors.push(`${p.id}: 없는 조각 "${d}"에 의존한다`);
      if (d === p.id) errors.push(`${p.id}: 자기 자신에 의존한다`);
    }
  }
  if (errors.length === 0 && topoOrder(pieces) === null) errors.push('deps에 순환이 있다');
  // 서로 다른 조각의 allowed_paths는 겹치면 안 된다.
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      for (const a of pieces[i].allowed_paths || []) {
        for (const b of pieces[j].allowed_paths || []) {
          if (typeof a === 'string' && typeof b === 'string' && patternsOverlap(a, b)) {
            errors.push(`allowed_paths가 겹친다: ${pieces[i].id} "${a}" ↔ ${pieces[j].id} "${b}"`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// git check-ref-format --branch 규칙 중 흔한 것(실행 때 git으로 한 번 더 확인한다).
export function isBranchName(b) {
  if (typeof b !== 'string' || !b || b.length > 200) return false;
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
  if (/[\s~^:?*[\]\\\u0000-\u001f\u007f]|\.\.|\/\/|@\{|\/\./.test(b)) return false;
  return b !== '@';
}

export function buildOrder(plan, piece, run) {
  const names = branchNames(run, piece.id);
  return {
    run,
    id: piece.id,
    agent: piece.agent,
    goal: piece.goal,
    allowed_paths: [...piece.allowed_paths],
    protected_paths: unique([
      ...ALWAYS_PROTECTED,
      ...DEFAULT_PROTECTED,
      ...((plan.contract && plan.contract.paths) || []),
      ...(plan.protected_paths || []),
      ...(piece.protected_paths || []),
    ]),
    verify: piece.verify ?? plan.verify,
    deps: [...(piece.deps || [])],
    max_files: piece.max_files ?? DEFAULT_MAX_FILES,
    max_diff_lines: piece.max_diff_lines ?? DEFAULT_MAX_DIFF_LINES,
    base: names.base,
    branch: names.piece,
    leases: [],
  };
}

export function orderJson(order) {
  return `${JSON.stringify(order, null, 2)}\n`;
}

function unique(a) {
  return [...new Set(a)];
}

// 임대 승인: allowed_paths를 늘린 새 ORDER를 돌려준다. 보호 경로는 빌려줄 수 없다.
export function grantLease(order, paths, { reason = '', letter = null, at = new Date().toISOString() } = {}) {
  const errors = [];
  for (const p of paths) {
    const bad = invalidPathReason(p);
    if (bad) errors.push(`"${p}" 경로가 바르지 않다(${bad})`);
    else if (/[*?]/.test(p)) errors.push(`"${p}" — 임대는 파일 하나씩만 한다(glob 금지)`);
    else if (matchAny(order.protected_paths, p, { ignoreCase: true })) errors.push(`"${p}"는 보호 경로라 빌려줄 수 없다`);
  }
  if (paths.length === 0) errors.push('빌릴 경로가 없다');
  if (errors.length) {
    const err = new Error(`임대 거부: ${errors.join(' / ')}`);
    err.errors = errors;
    throw err;
  }
  const added = paths.filter((p) => !order.allowed_paths.includes(p));
  return {
    ...order,
    allowed_paths: unique([...order.allowed_paths, ...paths]),
    // 빌린 파일 수만큼 파일 개수 상한도 늘린다(줄 수 상한은 그대로).
    max_files: order.max_files + added.length,
    leases: [...(order.leases || []), { paths: [...paths], reason, letter, at }],
  };
}

// lease-request 편지 본문에서 `path: <경로>` 줄을 꺼낸다.
export function parseLeasePaths(body) {
  return String(body || '').split(/\r?\n/)
    .map((l) => l.match(/^\s*path:\s*(\S+)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}
