// 어댑터 공용: 위험 권한 플래그 검사 · 환경 정리 · 프로세스 확인 · 프로세스 트리 종료.
import { execFile } from 'node:child_process';

// 정규화(소문자 · 공백 · 따옴표 제거)한 인자에 들어 있으면 안 되는 낱말.
export const BANNED_WORDS = [
  'dangerously-skip-permissions', 'dangerously-bypass', 'danger-full-access', 'bypasspermissions',
  'no-sandbox', 'sandbox=false', 'sandbox=off', 'sandbox=none', 'sandbox_mode=danger',
  'approval_policy=never', 'approval-policy=never', 'ask-for-approval=never', 'approvals=never',
  'full-auto',
];
export const BANNED_EXACT = ['--yolo', 'yolo', '-y', 'bypasspermissions', 'danger-full-access'];
// `--mode auto`처럼 값으로 권한을 넓히는 경우: 이 플래그 뒤(또는 =뒤)에 이 값이 오면 금지.
const MODE_FLAGS = ['--mode', '-m', '--approval-mode', '--permission-mode', '--ask-for-approval', '-a', '--sandbox-mode'];
const BANNED_MODE_VALUES = ['auto', 'yolo', 'full-auto', 'bypass', 'bypasspermissions', 'never', 'danger-full-access', 'dontask'];

export class DangerousFlagError extends Error {
  constructor(arg) {
    super(`위험 권한 플래그가 인자에 있다: ${String(arg).slice(0, 80)}`);
    this.name = 'DangerousFlagError';
  }
}

const norm = (a) => String(a).toLowerCase().replace(/[\s"'`]+/g, '');

// 모든 어댑터가 명령을 만들 때 이 함수 하나를 거친다.
// free: 지시문 · 메시지처럼 사람이 쓴 글 인자(검사하지 않는다 — 글 속의 낱말로 명령이 막히지 않게).
// 그 밖 인자는 공백 · 따옴표를 지우고 소문자로 바꾼 뒤 포함 여부로 본다(`sandbox_mode = "danger-full-access"`도 잡는다).
// 어댑터가 넣는 고정 인자에도 똑같이 건다(모든 명령 조립 함수가 이 함수로 끝난다).
export function assertSafeArgs(args, { free = [] } = {}) {
  const freeSet = new Set(free);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (freeSet.has(a)) continue;
    const t = norm(a);
    if (BANNED_EXACT.includes(t) || BANNED_WORDS.some((w) => t.includes(w))) throw new DangerousFlagError(a);
    const eq = t.match(/^(-{1,2}[a-z-]+)=(.*)$/);
    if (eq && MODE_FLAGS.includes(eq[1]) && BANNED_MODE_VALUES.includes(eq[2])) throw new DangerousFlagError(a);
    if (MODE_FLAGS.includes(t) && i + 1 < args.length && !freeSet.has(args[i + 1]) && BANNED_MODE_VALUES.includes(norm(args[i + 1]))) {
      throw new DangerousFlagError(`${a} ${args[i + 1]}`);
    }
  }
  return args;
}

// 설정 파일의 extraArgs는 권한 · 샌드박스 · 승인에 관한 것을 아예 넣지 못한다.
export function assertSafeExtraArgs(extra = []) {
  for (const a of extra) {
    if (/sandbox|approval|permission|danger|yolo|bypass/i.test(norm(a))) throw new DangerousFlagError(a);
  }
  return assertSafeArgs(extra);
}

// 에이전트(agy) · verify에 넘기는 환경 변수 허용 목록. Windows · macOS · Linux에서 프로그램이 뜨는 데 필요한 최소만이다.
// 목록에 없는 것(SSH_AUTH_SOCK · GIT_SSH_COMMAND · GIT_ASKPASS · DATABASE_URL · AWS_PROFILE · KUBECONFIG · 각종 토큰)은 넘기지 않는다.
export const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'COMPUTERNAME',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'NODE_EXTRA_CA_CERTS',
];
// 프록시는 주소에 자격 증명(user:pass@)이 없을 때만 넘긴다.
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

export function allowEnv(env = process.env) {
  const out = {};
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k];
  for (const k of PROXY_KEYS) if (env[k] !== undefined && !/@/.test(env[k])) out[k] = env[k];
  return out;
}

// 구독 계정만 쓰고, 에이전트에게 이 PC의 비밀값을 넘기지 않는다(허용 목록).
// git이 자격 증명을 묻거나 저장된 것을 쓰지 못하게 한다 — 그래도 에이전트의 git push 차단은 최종적으로 샌드박스(A1)에 달렸다.
export function stripSecrets(env = process.env) {
  const out = allowEnv(env);
  out.GIT_TERMINAL_PROMPT = '0';
  out.GCM_INTERACTIVE = 'never';
  out.GIT_CONFIG_COUNT = '1';
  out.GIT_CONFIG_KEY_0 = 'credential.helper';
  out.GIT_CONFIG_VALUE_0 = '';
  return out;
}

// 이전 이름(호환)
export const stripApiKeys = stripSecrets;

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 프로세스의 실행 파일 이름 · 시작 시각. 오래된 PID를 다른 프로세스가 물려받았는지 가리는 데 쓴다. 모르면 null.
// 부하가 크면 PowerShell이 늦게 뜬다 — 한 번 더 시도한다.
export async function processInfo(pid) {
  const first = await processInfoOnce(pid);
  if (first || !isAlive(pid)) return first;
  return processInfoOnce(pid);
}

function processInfoOnce(pid) {
  return new Promise((resolve) => {
    if (!pid || !isAlive(pid)) return resolve(null);
    const done = (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return resolve(null);
      resolve({ start: lines[0], name: lines[1] });
    };
    if (process.platform === 'win32') {
      const ps = `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o'); $p.ProcessName`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, shell: false, timeout: 60000 }, done);
    } else {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { shell: false, timeout: 10000 }, (e1, start) => {
        if (e1) return resolve(null);
        execFile('ps', ['-o', 'comm=', '-p', String(pid)], { shell: false, timeout: 10000 }, (e2, comm) => done(e2, `${start}\n${comm}`));
      });
    }
  });
}

export function sameProcess(a, b) {
  return !!(a && b && a.start === b.start && a.name === b.name);
}

// 프로세스 트리 종료. Windows는 taskkill /T /F, 그 밖은 프로세스 그룹(-pid)에 신호.
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid || !isAlive(pid)) return resolve(false);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, shell: false }, () => resolve(true));
      return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
    resolve(true);
  });
}

export async function waitDead(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// 출력에서 한도 오류를 알아본다(형식은 착수 때 확인 — 지금은 흔한 문구만).
export function looksLikeLimit(text) {
  return /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|limit reached/i.test(String(text || ''));
}

// `--output-format json` 결과에서 본문 글을 꺼낸다. 형식을 모르면 원문 그대로.
export function extractResultText(stdout) {
  const s = String(stdout || '').trim();
  try {
    const j = JSON.parse(s);
    if (j && typeof j.result === 'string') return j.result;
    if (j && typeof j.response === 'string') return j.response;
  } catch { /* JSON 아님 */ }
  return s;
}

// 출력에서 ID를 찾기 전에, 우리가 넣은 지시문과 인용 편지 칸을 지운다(지시문 속 ID 모양 글에 속지 않게).
export function stripEcho(stdout, prompt = '') {
  let s = String(stdout || '');
  if (prompt) s = s.split(prompt).join('');
  return s.replace(/<mail\b[\s\S]*?<\/mail>/g, '').replace(/<review\b[\s\S]*?<\/review>/g, '').replace(/<decisions\b[\s\S]*?<\/decisions>/g, '');
}
