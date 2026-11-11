// 교차 검토: 검토자 돌려 막기 · 검토 결과 해석(fail-closed).
export const VENDOR = { claude: 'anthropic', codex: 'openai', antigravity: 'google' };
const ROTATION = { claude: 'codex', codex: 'antigravity', antigravity: 'claude' };
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const MAX_REREVIEWS = 2;

// available: 지금 쓸 수 있는 에이전트(꺼진 agy 등은 뺀다). 돌려 막기 순서대로 다음 「다른 회사」 에이전트를 고른다.
export function pickReviewer(author, available = Object.keys(VENDOR)) {
  if (!ROTATION[author]) throw new Error(`작성자 "${author}"를 모른다`);
  let reviewer = ROTATION[author];
  for (let i = 0; i < Object.keys(ROTATION).length; i++) {
    if (available.includes(reviewer) && VENDOR[reviewer] && VENDOR[reviewer] !== VENDOR[author]) return reviewer;
    reviewer = ROTATION[reviewer];
  }
  throw new Error(`작성자 ${author}와 다른 회사의 검토자가 없다(쓸 수 있는 에이전트: ${available.join(', ') || '없음'})`);
}

const fail = (reason, extra = {}) => ({ verdict: 'FAIL', reason, findings: [], ...extra });

// 검토자 쪽 문제(응답 없음 · 형식 깨짐 · 토큰 어긋남)인가. 작성자 탓이 아니므로 작성자에게 고치라고 보내지 않는다.
export const REVIEWER_FAULTS = ['no-response', 'broken-json', 'not-object', 'unexpected-keys', 'bad-verdict', 'bad-findings', 'bad-finding', 'bad-finding-file', 'bad-finding-line', 'bad-finding-severity', 'bad-finding-summary', 'bad-token', 'token-mismatch', 'reviewer-failed', 'reviewer-limit'];

// text: 검토자 응답(검토 JSON만이어야 한다 — 그대로이거나 ```json 칸 하나).
// codeChanged: 검토 중 코드가 바뀌었는가. 바뀌었으면 결과를 버리고 FAIL.
// expectedToken: 전달함 · 검토 브랜치로 받은 검토는 이번 회차 토큰이 맞아야 한다(옛 편지 · 남의 편지를 받지 않게).
export function parseReview(text, { codeChanged = false, expectedToken = null } = {}) {
  if (codeChanged) return fail('review-modified-code');
  if (text === null || text === undefined || !String(text).trim()) return fail('no-response');
  let src = String(text).trim();
  const fence = src.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) src = fence[1].trim();
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return fail('broken-json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('not-object');
  const keys = Object.keys(data).filter((k) => k !== 'token').sort().join(',');
  if (keys !== 'findings,verdict') return fail('unexpected-keys');
  if ('token' in data && typeof data.token !== 'string') return fail('bad-token');
  if (expectedToken !== null && data.token !== expectedToken) return fail('token-mismatch');
  if (data.verdict !== 'PASS' && data.verdict !== 'FAIL') return fail('bad-verdict');
  if (!Array.isArray(data.findings)) return fail('bad-findings');
  const findings = [];
  for (const f of data.findings) {
    if (!f || typeof f !== 'object') return fail('bad-finding');
    if (typeof f.file !== 'string') return fail('bad-finding-file');
    if (!(f.line === null || (Number.isInteger(f.line) && f.line >= 0))) return fail('bad-finding-line');
    if (!SEVERITIES.includes(f.severity)) return fail('bad-finding-severity');
    if (typeof f.summary !== 'string' || !f.summary.trim()) return fail('bad-finding-summary');
    findings.push({ file: f.file, line: f.line, severity: f.severity, summary: f.summary });
  }
  // PASS인데 심각한 지적이 있으면 앞뒤가 안 맞는다 → FAIL.
  if (data.verdict === 'PASS' && findings.some((f) => f.severity === 'critical' || f.severity === 'high')) {
    return fail('inconsistent-pass', { findings });
  }
  return { verdict: data.verdict, reason: data.verdict === 'PASS' ? 'ok' : 'reviewer-fail', findings };
}

export function formatFindings(result) {
  if (!result.findings.length) return `판정 ${result.verdict} (${result.reason})`;
  return [`판정 ${result.verdict} (${result.reason})`, ...result.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.summary}`)].join('\n');
}
