// 전달함: `trio/mailbox` orphan 브랜치의 runs/<실행>/ 아래에 편지 파일을 추가만 한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitToBranch, withRepoLock, fetchBranch, ensureWorktree, remoteBranchExists, markWorktreeReady, revParse } from './gitops.mjs';
import { withFileLock } from './lock.mjs';
import { redact } from './redact.mjs';
import { notifyControlWrite } from './ledger.mjs';

export const MAILBOX_BRANCH = 'trio/mailbox';
export const LETTER_TYPES = ['request', 'suggestion', 'question', 'answer', 'lease-request', 'lease-grant', 'blocker', 'fyi', 'handoff', 'review'];
export const PARTICIPANTS = ['head', 'claude', 'codex', 'antigravity'];
export const MAX_BODY_BYTES = 4096;
export const NAME_RE = /^\d{8}T\d{9}-(head|claude|codex|antigravity)-[0-9a-f]{6}\.md$/;
const HEADER_KEYS = ['from', 'to', 'type', 're', 'needs_reply', 'order'];

// 비밀값 패턴. 하나라도 맞으면 보내기 · 중계를 거부한다.
// 앞 경계는 \b가 아니라 「영숫자가 아닌 글자」다(`OPENAI_API_KEY=` · `x_sk-…`처럼 `_` 뒤도 잡는다).
const B = '(?:^|[^A-Za-z0-9])';
const KEY_NAME = '[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*';
export const SECRET_PATTERNS = [
  ['openai-anthropic-key', new RegExp(`${B}sk-[A-Za-z0-9_-]{16,}`)],
  ['stripe-key', new RegExp(`${B}[sr]k_(?:live|test)_[A-Za-z0-9]{10,}`)],
  ['github-token', new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{20,}`)],
  ['github-pat', new RegExp(`${B}github_pat_[A-Za-z0-9_]{20,}`)],
  ['gitlab-token', new RegExp(`${B}glpat-[A-Za-z0-9_-]{16,}`)],
  ['npm-token', new RegExp(`${B}npm_[A-Za-z0-9]{30,}`)],
  ['aws-access-key', new RegExp(`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`)],
  ['google-api-key', new RegExp(`${B}AIza[0-9A-Za-z_-]{30,}`)],
  ['slack-token', new RegExp(`${B}xox[abprs]-[A-Za-z0-9-]{10,}`)],
  ['jwt', new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.`)],
  ['bearer', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['google-oauth', new RegExp(`${B}ya29\\.[0-9A-Za-z_-]{20,}`)],
  ['huggingface-token', new RegExp(`${B}hf_[A-Za-z0-9]{30,}`)],
  ['azure-account-key', /AccountKey=[A-Za-z0-9+/]{20,}={0,2}/],
];

// `이름 = 값` 꼴. 이름이 password · client_secret · *_TOKEN 계열이면 값 모양을 따지지 않고(8자 이상), 그 밖 키 이름은 숫자가 든 값만 잡는다.
// 코드는 빼려고: 이름이 Count · Length · Size · Id로 끝남, 값 뒤에 `(`, 값이 `a.b.c` 같은 멤버 접근, 흔한 낱말 값.
const ASSIGN_RE = new RegExp(`(["']?)(${KEY_NAME})\\1\\s*[:=]\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'\`,;(){}\\[\\]]+))`, 'gi');
const STRICT_KEY_RE = /passw(?:or)?d|passphrase|client[_-]?secret|_token$|^token_|access[_-]?token|refresh[_-]?token|secret[_-]?key|private[_-]?key/i;
const NOT_SECRET_KEY_RE = /(count|length|size|id)$/i;
const CODE_WORDS = new Set(['undefined', 'function', 'required', 'optional', 'boolean', 'process.env', 'nullable']);

function findAssignment(text) {
  ASSIGN_RE.lastIndex = 0;
  let m;
  while ((m = ASSIGN_RE.exec(text))) {
    const key = m[2];
    const quoted = m[3] ?? m[4];
    const value = quoted ?? m[5];
    if (NOT_SECRET_KEY_RE.test(key) || !value || value.length < 8) continue;
    if (quoted === undefined) {
      const next = text[m.index + m[0].length];
      if (next === '(' || next === '[') continue; // 함수 호출 · 인덱스
      if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) continue; // process.env.X 같은 멤버 접근
      if (CODE_WORDS.has(value.toLowerCase())) continue;
    }
    if (STRICT_KEY_RE.test(key) || /\d/.test(value)) return true;
  }
  return false;
}

export function findSecret(text) {
  const s = String(text);
  for (const [name, re] of SECRET_PATTERNS) if (re.test(s)) return name;
  if (findAssignment(s)) return 'generic-assignment';
  return null;
}

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
}

export function letterName(from, now = new Date()) {
  return `${stamp(now)}-${from}-${crypto.randomBytes(3).toString('hex')}.md`;
}

// 편지 이름의 시각(밀리초). 형식이 아니면 NaN.
export function letterTime(name) {
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})-/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

export function nameSender(name) {
  const m = String(name).match(NAME_RE);
  return m ? m[1] : null;
}

export function validateLetter(l) {
  const errors = [];
  if (!PARTICIPANTS.includes(l.from)) errors.push(`from "${l.from}"이 참가자가 아니다`);
  if (!PARTICIPANTS.includes(l.to)) errors.push(`to "${l.to}"가 참가자가 아니다`);
  if (l.from === l.to) errors.push('자기 자신에게 보낼 수 없다');
  if (!LETTER_TYPES.includes(l.type)) errors.push(`type "${l.type}"은 ${LETTER_TYPES.join(' | ')} 중 하나여야 한다`);
  if (l.re && !NAME_RE.test(l.re)) errors.push(`re "${l.re}"가 편지 이름 형식이 아니다`);
  if (typeof l.needs_reply !== 'boolean') errors.push('needs_reply는 true/false다');
  if (l.order && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(l.order)) errors.push(`order "${l.order}" 형식이 바르지 않다`);
  for (const k of HEADER_KEYS) {
    if (/[\r\n]/.test(String(l[k] ?? ''))) errors.push(`${k}에 줄바꿈이 있다`);
  }
  const body = String(l.body ?? '');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) errors.push(`본문이 ${MAX_BODY_BYTES}바이트를 넘는다`);
  const secret = findSecret([body, ...HEADER_KEYS.map((k) => l[k] ?? '')].join('\n'));
  if (secret) errors.push(`비밀값 패턴(${secret})이 있다 — 보내지 않는다`);
  return errors;
}

export function formatLetter(l) {
  return [
    '---',
    `from: ${l.from}`,
    `to: ${l.to}`,
    `type: ${l.type}`,
    `re: ${l.re || ''}`,
    `needs_reply: ${l.needs_reply ? 'true' : 'false'}`,
    `order: ${l.order || ''}`,
    '---',
    String(l.body ?? '').replace(/\r\n/g, '\n'),
  ].join('\n') + (String(l.body ?? '').endsWith('\n') ? '' : '\n');
}

export function parseLetter(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('편지 머리말(---)이 없다');
  const head = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-z_]+):\s?(.*)$/);
    if (!mm) throw new Error(`머리말 줄 형식이 바르지 않다: ${line}`);
    if (!HEADER_KEYS.includes(mm[1])) throw new Error(`모르는 머리말 칸: ${mm[1]}`);
    if (mm[1] in head) throw new Error(`머리말 칸이 겹친다: ${mm[1]}`);
    head[mm[1]] = mm[2].trim();
  }
  for (const k of ['from', 'to', 'type', 'needs_reply']) if (!(k in head)) throw new Error(`머리말 ${k}가 없다`);
  if (!['true', 'false'].includes(head.needs_reply)) throw new Error('needs_reply는 true/false다');
  let body = m[2];
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return {
    from: head.from, to: head.to, type: head.type, re: head.re || '', order: head.order || '',
    needs_reply: head.needs_reply === 'true', body,
  };
}

// 상자 안 편지 파일 하나를 검사한다: 형식 · 검증 · 이름의 보낸이 = 머리말 from · 폴더 = to. 어긋나면 이유 문자열.
export function checkBoxFile(name, text, folder) {
  if (!NAME_RE.test(name)) return '파일 이름 형식이 아니다';
  let l;
  try {
    l = parseLetter(text);
  } catch (err) {
    return err.message;
  }
  if (l.from !== nameSender(name)) return `이름의 보낸이(${nameSender(name)})와 머리말 from(${l.from})이 다르다`;
  if (l.to !== folder) return `상자(${folder})와 머리말 to(${l.to})가 다르다`;
  const errors = validateLetter(l);
  if (errors.length) return errors.join(' / ');
  return null;
}

// git diff --raw -z (이름 변경 끔) 해석
function parseRaw(out) {
  const parts = out.split('\0');
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const h = parts[i];
    if (!h || !h.startsWith(':')) continue;
    const f = h.slice(1).split(' ');
    res.push({ status: f[4][0], path: parts[i + 1], newSha: f[3], newMode: f[1] });
    i += 1;
  }
  return res;
}

// 전달함 worktree 안 파일은 보통 파일일 때만 읽고 쓴다(심볼릭 링크를 따라가 밖을 읽거나 쓰지 않게).
function regularFile(f) {
  try {
    const st = fs.lstatSync(f);
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'none';
  }
}

// 쓰기 전: 보통 파일이 아니면(링크 · 폴더 등) 지우고 새로 쓴다.
function safeWrite(f, text, { append = false } = {}) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const kind = regularFile(f);
  if (kind === 'other') fs.rmSync(f, { recursive: true, force: true });
  if (append && kind === 'file') fs.appendFileSync(f, text);
  else fs.writeFileSync(f, text);
}

export const MAX_AUDIT_COMMITS = 500;

export class Mailbox {
  // repoDir: 원격(origin)이 있는 로컬 clone. worktreeDir: 전달함 전용 worktree 자리.
  // HEAD 전용 선택 칸:
  //   stateDir — 잠금 파일 · HEAD가 만든 커밋 · 보낸 편지 이름 · 결정 게시판 로컬 사본을 둔다(실행 폴더).
  //   redactPaths — 편지 · 결정에서 가릴 경로.
  constructor({ repoDir, run, worktreeDir, remote = 'origin', now = () => new Date(), retries = 5, stateDir = null, redactPaths = [] }) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(run || '')) throw new Error(`실행 이름 "${run}" 형식이 바르지 않다`);
    this.repoDir = repoDir;
    this.run = run;
    this.worktreeDir = worktreeDir;
    this.remote = remote;
    this.now = now;
    this.retries = retries;
    this.stateDir = stateDir;
    this.redactPaths = [repoDir, worktreeDir, stateDir, ...redactPaths].filter(Boolean);
    this.queue = Promise.resolve();
    this.warnings = [];
    this.quarantine = new Set();
    this.readAtAudited = false;
    this.auditedTip = null;
  }

  get root() {
    return `runs/${this.run}`;
  }

  get ownFile() {
    return this.stateDir ? path.join(this.stateDir, 'mailbox-own.json') : null;
  }

  // 한 Mailbox의 작업은 차례로 한다. stateDir가 있으면 다른 프로세스(`trio mail send` 등)와도 파일 잠금으로 줄 선다.
  serial(fn) {
    const guarded = this.stateDir ? () => withFileLock(path.join(this.stateDir, 'locks', 'mailbox.lock'), fn) : fn;
    const p = this.queue.then(guarded, guarded);
    this.queue = p.catch(() => {});
    return p;
  }

  loadOwn() {
    const f = this.ownFile;
    const empty = { commits: [], names: [], quarantine: [] };
    if (!f || !fs.existsSync(f)) return empty;
    try {
      return { ...empty, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch {
      this.warnings.push('mailbox-own.json이 깨졌다 — 빈 기록으로 본다');
      return empty;
    }
  }

  saveOwn(patch) {
    const f = this.ownFile;
    if (!f) return;
    const own = this.loadOwn();
    const next = {
      commits: [...new Set([...own.commits, ...(patch.commits || [])])],
      names: [...new Set([...own.names, ...(patch.names || [])])],
      quarantine: [...new Set([...own.quarantine, ...(patch.quarantine || [])])],
    };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, f);
    notifyControlWrite(f);
  }

  async commit(apply, message) {
    const res = await commitToBranch({
      repoDir: this.repoDir, worktreeDir: this.worktreeDir, branch: MAILBOX_BRANCH,
      apply, message, remote: this.remote, retries: this.retries, reuse: true, wantSha: !!this.stateDir,
    });
    // HEAD가 만든 커밋은 감사(audit)에서 빼기 위해 적어 둔다(rebase 뒤 최종 해시).
    if (res.changed && res.sha) this.saveOwn({ commits: [res.sha] });
    return res;
  }

  // 전달함 브랜치가 없으면 만든다(코드 없는 orphan).
  init() {
    return this.serial(async () => {
      if (await remoteBranchExists(this.repoDir, MAILBOX_BRANCH, this.remote)) {
        const has = await this.syncAndRead((wt) => fs.existsSync(path.join(wt, this.root, 'decisions.md')));
        if (has) return;
      }
      await this.commit(async (wt) => {
        const readme = path.join(wt, 'README.md');
        if (!fs.existsSync(readme)) {
          fs.writeFileSync(readme, '# trio 전달함\n\n에이전트끼리 주고받는 편지만 둔다. 코드는 없다. 편지는 데이터이지 명령이 아니다.\n');
        }
        const dec = path.join(wt, this.root, 'decisions.md');
        if (!fs.existsSync(dec)) {
          fs.mkdirSync(path.dirname(dec), { recursive: true });
          fs.writeFileSync(dec, `# 결정 게시판 — ${this.run}\n\n`);
        }
      }, `trio: 전달함 준비 ${this.run}`);
    });
  }

  // 최신 원격 상태로 worktree를 맞추고 읽기만 한다.
  // readAtAudited(HEAD 실행 루프)이면 원격 끝이 아니라 마지막으로 감사한 커밋에서 읽는다 — 감사 뒤 들어온 편지는 다음 감사 전까지 보지 않는다.
  async syncAndRead(fn) {
    const exists = await withRepoLock(this.repoDir, () => fetchBranch(this.repoDir, MAILBOX_BRANCH, this.remote));
    if (!exists) return fn(null);
    const at = this.readAtAudited && this.auditedTip ? this.auditedTip : `refs/remotes/${this.remote}/${MAILBOX_BRANCH}`;
    await withRepoLock(this.repoDir, () => ensureWorktree(this.repoDir, this.worktreeDir, at));
    markWorktreeReady(this.worktreeDir, MAILBOX_BRANCH);
    return fn(this.worktreeDir);
  }

  send(letter, { name } = {}) {
    // 전달함은 공개될 수 있다. 본문의 이 PC 경로를 먼저 가린다.
    const l = { re: '', order: '', needs_reply: false, ...letter, body: redact(letter.body, { paths: this.redactPaths }) };
    const errors = validateLetter(l);
    if (errors.length) {
      const err = new Error(`편지 거부: ${errors.join(' / ')}`);
      err.errors = errors;
      return Promise.reject(err);
    }
    const fileName = name || letterName(l.from, this.now());
    const rel = `${this.root}/mailbox/${l.to}/${fileName}`;
    const text = formatLetter(l);
    return this.serial(async () => {
      await this.commit(async (wt) => {
        const abs = path.join(wt, rel);
        if (fs.existsSync(abs)) return false; // 이미 있는 편지는 고치지 않는다
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        return true;
      }, `trio: 편지 ${l.from}→${l.to} ${l.type}`);
      this.saveOwn({ names: [fileName] });
      return { name: fileName, path: rel, ...l };
    });
  }

  reply(original, { from, type = 'answer', body, needs_reply = false }) {
    return this.send({ from, to: original.from, type, re: original.name, order: original.order || '', needs_reply, body });
  }

  // 읽음 기록이 깨졌으면 빈 집합으로 본다(실행 전체를 멈추지 않는다 — 경고만 남긴다).
  readReadSet(wt, to) {
    if (!wt) return new Set();
    const f = path.join(wt, this.root, 'read', `${to}.json`);
    const kind = regularFile(f);
    if (kind === 'none') return new Set();
    if (kind === 'other') {
      this.warnings.push(`읽음 기록 read/${to}.json이 보통 파일이 아니다 — 빈 기록으로 본다`);
      return new Set();
    }
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!data || !Array.isArray(data.read)) throw new Error('read 배열이 없다');
      return new Set(data.read.filter((n) => typeof n === 'string'));
    } catch (err) {
      this.warnings.push(`읽음 기록 read/${to}.json이 깨졌다(${err.message}) — 빈 기록으로 본다`);
      return new Set();
    }
  }

  readBox(wt, to) {
    if (!wt) return [];
    const dir = path.join(wt, this.root, 'mailbox', to);
    if (!fs.existsSync(dir)) return [];
    const quarantined = new Set([...this.quarantine, ...this.loadOwn().quarantine]);
    return fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort().map((name) => {
      let text;
      if (regularFile(path.join(dir, name)) !== 'file') return { name, broken: '보통 파일이 아니다(링크 등)', body: '' };
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (err) {
        return { name, broken: `읽지 못했다: ${err.message}`, body: '' };
      }
      if (quarantined.has(name)) return { name, broken: '감사에서 걸린 편지(격리)', body: '' };
      const bad = checkBoxFile(name, text, to);
      if (bad) return { name, broken: bad, body: '' };
      return { name, ...parseLetter(text) };
    });
  }

  // 받은 편지 전부(읽음 여부 포함).
  list(to) {
    return this.serial(() => this.syncAndRead((wt) => {
      const read = this.readReadSet(wt, to);
      return this.readBox(wt, to).map((l) => ({ ...l, read: read.has(l.name) }));
    }));
  }

  // 아직 읽지 않은 편지. 읽음 기록은 「읽은 파일 이름 집합」이다(시계가 어긋나도 빠지는 편지가 없게).
  async peek(to) {
    return (await this.list(to)).filter((l) => !l.read);
  }

  async readNew(to, { mark = true } = {}) {
    const letters = await this.peek(to);
    if (mark && letters.length) await this.markRead(to, letters.map((l) => l.name));
    return letters;
  }

  markRead(to, names) {
    if (!PARTICIPANTS.includes(to)) return Promise.reject(new Error(`받는이 "${to}"가 참가자가 아니다`));
    return this.serial(() => this.commit(async (wt) => {
      const set = this.readReadSet(wt, to);
      for (const n of names) set.add(n);
      safeWrite(path.join(wt, this.root, 'read', `${to}.json`), `${JSON.stringify({ read: [...set].sort() }, null, 2)}\n`);
    }, `trio: 읽음 ${to} +${names.length}`));
  }

  get localDecisionsFile() {
    return this.stateDir ? path.join(this.stateDir, 'decisions.jsonl') : null;
  }

  // 결정은 HEAD 로컬 사본(실행 폴더)에 먼저 적고, 전달함 게시판에도 한 줄 더한다.
  // 지시문에는 로컬 사본만 넣는다(게시판은 직접형 에이전트가 고칠 수 있다).
  appendDecision(text, { by = 'head' } = {}) {
    const clean = redact(text, { paths: this.redactPaths });
    if (/[\r\n]/.test(clean)) return Promise.reject(new Error('결정은 한 줄이다'));
    const secret = findSecret(clean);
    if (secret) return Promise.reject(new Error(`결정에 비밀값 패턴(${secret})이 있다`));
    const at = this.now().toISOString();
    const line = `- ${at} [${by}] ${clean}\n`;
    return this.serial(async () => {
      if (this.localDecisionsFile) {
        fs.mkdirSync(path.dirname(this.localDecisionsFile), { recursive: true });
        fs.appendFileSync(this.localDecisionsFile, `${JSON.stringify({ at, by, text: clean })}\n`);
        notifyControlWrite(this.localDecisionsFile);
      }
      return this.commit(async (wt) => {
        const f = path.join(wt, this.root, 'decisions.md');
        if (regularFile(f) !== 'file') safeWrite(f, `# 결정 게시판 — ${this.run}\n\n`);
        safeWrite(f, line, { append: true });
      }, 'trio: 결정 추가');
    });
  }

  // HEAD 로컬 사본(믿을 수 있는 쪽). [{at, by, text}]
  readLocalDecisions() {
    const f = this.localDecisionsFile;
    if (!f || !fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  // 전달함 게시판(공유 사본 — 보기용).
  readDecisions() {
    return this.serial(() => this.syncAndRead((wt) => {
      if (!wt) return [];
      const f = path.join(wt, this.root, 'decisions.md');
      if (!fs.existsSync(f)) return [];
      return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('- '));
    }));
  }

  heartbeat(agent, data) {
    if (!PARTICIPANTS.includes(agent)) return Promise.reject(new Error(`에이전트 "${agent}"가 참가자가 아니다`));
    const body = { agent, at: this.now().toISOString(), ...data };
    return this.serial(() => this.commit(async (wt) => {
      safeWrite(path.join(wt, this.root, 'status', `${agent}.json`), `${JSON.stringify(body, null, 2)}\n`);
    }, `trio: 하트비트 ${agent}`));
  }

  // 하트비트. receivedAt은 HEAD가 받은(fetch한) 시각이다 — 에이전트가 쓴 시각(at)은 믿지 않는다.
  readHeartbeats() {
    return this.serial(() => this.syncAndRead((wt) => {
      const out = {};
      if (!wt) return out;
      const dir = path.join(wt, this.root, 'status');
      if (!fs.existsSync(dir)) return out;
      const receivedAt = new Date().toISOString();
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.json') || regularFile(path.join(dir, n)) !== 'file') continue;
        try { out[n.slice(0, -5)] = { ...JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')), receivedAt }; } catch { /* 깨진 하트비트는 무시 */ }
      }
      return out;
    }));
  }

  // 감사: since 뒤로 HEAD가 만들지 않은 커밋을 하나씩 보고, since → 끝 누적 차이도 본다.
  // 커밋별 허용: 직접형 에이전트가 자기 이름으로 낸 새 편지(보통 파일 모드) · 자기 상자의 읽음 기록 · 자기 하트비트.
  // 위반: 남의 이름 편지 · 편지 수정 · 삭제 · 남의 기록 · 결정 게시판 수정 · 다른 파일 · 보통 파일이 아닌 모드 ·
  //       병합 커밋(부모 2개 이상) · 루트 커밋 · 커밋 수 상한 초과 · 강제 푸시(역사 고침).
  // 누적: since에 있던 편지는 끝에서도 그대로 있어야 하고, 결정 게시판은 앞부분이 그대로인 채 뒤에만 붙어야 한다.
  // 돌려주는 것: { tip, violations: [{commit, path, rule, actors}], rewritten }.
  //   actors가 비어 있으면 「누가 했는지 모름」이다 — 실행 루프는 실행 전체를 멈춘다(MAILBOX_TAMPERED).
  // 걸린 편지는 격리해 아무도 못 읽게 한다.
  audit({ since, directAgents = [], maxCommits = MAX_AUDIT_COMMITS }) {
    return this.serial(async () => {
      const exists = await withRepoLock(this.repoDir, () => fetchBranch(this.repoDir, MAILBOX_BRANCH, this.remote));
      if (!exists) return { tip: null, violations: since ? [{ commit: null, path: MAILBOX_BRANCH, rule: 'branch-deleted', actors: [] }] : [] };
      const tip = await revParse(this.repoDir, `refs/remotes/${this.remote}/${MAILBOX_BRANCH}`);
      if (!since || since === tip) {
        this.auditedTip = tip;
        return { tip, violations: [] };
      }
      // 강제 푸시로 역사를 고쳤으면(전에 본 끝이 조상이 아니면) 지운 편지를 알 수 없다 → 위반. 기준(auditedTip)은 옮기지 않는다.
      const ancestor = await git(this.repoDir, ['merge-base', '--is-ancestor', since, tip], { allowFail: true });
      if (ancestor === null) return { tip, rewritten: true, violations: [{ commit: tip, path: MAILBOX_BRANCH, rule: 'history-rewritten', actors: [] }] };
      const own = new Set(this.loadOwn().commits);
      const lines = (await git(this.repoDir, ['rev-list', '--reverse', '--parents', `${since}..${tip}`])).trim().split('\n').filter(Boolean);
      const violations = [];
      const quarantine = [];
      const prefix = `${this.root}/`;
      if (lines.length > maxCommits) {
        return { tip, violations: [{ commit: tip, path: MAILBOX_BRANCH, rule: `too-many-commits:${lines.length}>${maxCommits}`, actors: [] }] };
      }
      for (const line of lines) {
        const [c, ...parents] = line.split(' ');
        // 병합 커밋은 첫 부모와의 차이만 보면 되돌리기를 숨길 수 있다. 루트 커밋은 비교할 부모가 없다. 둘 다 그 자체로 위반.
        if (parents.length !== 1) {
          violations.push({ commit: c, path: MAILBOX_BRANCH, rule: parents.length ? 'merge-commit' : 'root-commit', actors: [] });
          continue;
        }
        if (own.has(c)) continue;
        const raw = await git(this.repoDir, ['-c', 'core.quotePath=false', 'diff', '--raw', '--no-abbrev', '-z', '--no-renames', parents[0], c]);
        const actors = new Set();
        const bad = [];
        for (const ch of parseRaw(raw)) {
          const p = ch.path;
          if (p.startsWith('runs/') && !p.startsWith(prefix)) continue; // 다른 실행 — 그 실행의 HEAD가 본다
          if (ch.status !== 'D' && ch.newMode !== '100644') { bad.push({ path: p, rule: `bad-mode:${ch.newMode}` }); continue; }
          const rel = p.startsWith(prefix) ? p.slice(prefix.length) : null;
          const m = rel && rel.match(/^mailbox\/([a-z]+)\/([^/]+)$/);
          if (m) {
            const sender = nameSender(m[2]);
            if (ch.status !== 'A') { bad.push({ path: p, rule: 'letter-modified' }); continue; }
            if (!sender || !directAgents.includes(sender)) {
              bad.push({ path: p, rule: 'forged-sender' });
              if (NAME_RE.test(m[2])) quarantine.push(m[2]);
              continue;
            }
            const text = await git(this.repoDir, ['show', `${c}:${p}`], { allowFail: true });
            const why = text === null ? '읽지 못함' : checkBoxFile(m[2], text, m[1]);
            if (why) { bad.push({ path: p, rule: `bad-letter:${why}`.slice(0, 200) }); quarantine.push(m[2]); continue; }
            actors.add(sender);
            continue;
          }
          const r = rel && rel.match(/^(read|status)\/([a-z]+)\.json$/);
          if (r && ch.status !== 'D' && directAgents.includes(r[2])) {
            actors.add(r[2]);
            continue;
          }
          bad.push({ path: p, rule: r ? `${r[1]}-tamper` : rel === 'decisions.md' ? 'decisions-tamper' : 'unexpected-file' });
        }
        // 한 커밋에 자기 편지(누구인지 알 수 있는 것)가 함께 있으면 그 에이전트 탓, 없으면 「모름」.
        for (const v of bad) violations.push({ commit: c, ...v, actors: [...actors] });
      }
      // 누적 검사: since에 있던 편지 · 결정 게시판 앞부분이 끝에서 바뀌거나 사라졌으면 위반(커밋별 검사를 피한 되돌리기도 잡는다).
      const cum = await git(this.repoDir, ['-c', 'core.quotePath=false', 'diff', '--raw', '--no-abbrev', '-z', '--no-renames', since, tip]);
      for (const ch of parseRaw(cum)) {
        const p = ch.path;
        if (p.startsWith('runs/') && !p.startsWith(prefix)) continue;
        const rel = p.startsWith(prefix) ? p.slice(prefix.length) : null;
        if (ch.status === 'A') continue; // 새 파일은 커밋별 검사가 본다
        if (rel && /^(read|status)\/[a-z]+\.json$/.test(rel) && ch.status !== 'D') continue;
        if (rel === 'decisions.md' && ch.status === 'M') {
          const before = await git(this.repoDir, ['show', `${since}:${p}`], { allowFail: true });
          const after = await git(this.repoDir, ['show', `${tip}:${p}`], { allowFail: true });
          if (before !== null && after !== null && after.startsWith(before)) continue;
        }
        if (!violations.some((v) => v.path === p)) violations.push({ commit: tip, path: p, rule: `cumulative-${ch.status === 'D' ? 'delete' : 'change'}`, actors: [] });
      }
      if (quarantine.length) {
        for (const n of quarantine) this.quarantine.add(n);
        this.saveOwn({ quarantine });
      }
      this.auditedTip = tip;
      return { tip, violations };
    });
  }
}
