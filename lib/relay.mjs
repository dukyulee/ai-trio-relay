// 중계: 전달함에 직접 못 쓰는 에이전트(Codex 등)가 결과에 담은 `.trio/outbox/*.md`를 꺼내 검증한 뒤 전달함으로 옮긴다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, fetchBranch, commitToBranch, withRepoLock } from './gitops.mjs';
import { parseLetter, validateLetter } from './mailbox.mjs';
import { readJson, writeJson } from './ledger.mjs';
import { OUTBOX_PREFIX } from './scope.mjs';

// 편지 한 통(문자열)을 검증한다. 보낸이는 그 조각의 작성자로 고정한다(다른 이름을 쓰면 거부).
export function checkRelayLetter(text, { agent, order }) {
  let l;
  try {
    l = parseLetter(text);
  } catch (err) {
    return { ok: false, reason: `형식 오류: ${err.message}` };
  }
  if (l.from !== agent) return { ok: false, reason: `보낸이 "${l.from}"가 작성자 "${agent}"와 다르다` };
  if (!l.order) l.order = order;
  if (l.order !== order) return { ok: false, reason: `order "${l.order}"가 조각 "${order}"와 다르다` };
  const errors = validateLetter(l);
  if (errors.length) return { ok: false, reason: errors.join(' / ') };
  return { ok: true, letter: l };
}

export const DONE_FILE = '.trio/outbox/done.md';
export const UNPARSED = '<해석 못 한 diff 머리말>';

// unified diff에서 파일별로 새로 생긴 내용을 꺼낸다(Codex `cloud diff` 결과용).
// 따옴표 경로(`diff --git "a/…" "b/…"` — 한글 · 특수 문자)처럼 해석 못 한 머리말은 unparsed로 둔다(fail-closed).
export function parsePatchFiles(patch) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(patch).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff ')) {
      const m = line.match(/^diff --git a\/([^"\s][^"]*?) b\/([^"\s][^"]*)$/);
      cur = m
        ? { path: m[2], oldPath: m[1], isNew: false, deleted: false, lines: [] }
        : { path: UNPARSED, oldPath: UNPARSED, isNew: false, deleted: false, lines: [], unparsed: true };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      else if (line.startsWith('+++ ') && !cur.unparsed) {
        const p = line.slice(4).replace(/^b\//, '');
        // 머리말과 다른 경로 · 따옴표 경로는 믿지 않는다.
        if (p.startsWith('"') || (p !== '/dev/null' && p !== cur.path)) {
          cur.unparsed = true;
          cur.path = UNPARSED;
        }
      } else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.lines.push(line.slice(1));
    else if (line.startsWith('\\')) continue;
  }
  return files.map((f) => ({ path: f.path, oldPath: f.oldPath, isNew: f.isNew, deleted: f.deleted, unparsed: !!f.unparsed, content: f.lines.length ? `${f.lines.join('\n')}\n` : '' }));
}

export function outboxFilesFromPatch(patch) {
  return parsePatchFiles(patch).filter((f) => !f.unparsed && f.path.startsWith(OUTBOX_PREFIX) && f.isNew);
}

// 편지 자리 밖을 건드린 경로. 해석 못 한 머리말은 늘 「밖」으로 센다.
export function nonOutboxPathsFromPatch(patch) {
  return parsePatchFiles(patch).filter((f) => f.unparsed || !f.path.startsWith(OUTBOX_PREFIX) || !f.oldPath.startsWith(OUTBOX_PREFIX)).map((f) => f.path);
}

function relayedFile(runDir) {
  return path.join(runDir, 'relayed.json');
}

// 이미 옮긴 편지(내용 해시)를 기억해 두 번 옮기지 않는다.
async function deliver({ items, agent, order, mailbox, runDir }) {
  const seen = new Set(readJson(relayedFile(runDir), []));
  const sent = [];
  const rejected = [];
  for (const it of items) {
    const key = crypto.createHash('sha256').update(`${order}\0${it.path}\0${it.content}`).digest('hex');
    if (seen.has(key)) continue;
    const res = checkRelayLetter(it.content, { agent, order });
    if (!res.ok) {
      rejected.push({ path: it.path, reason: res.reason });
    } else {
      const s = await mailbox.send(res.letter);
      sent.push(s.name);
    }
    seen.add(key);
    writeJson(relayedFile(runDir), [...seen]);
  }
  if (rejected.length) {
    await mailbox.send({
      from: 'head', to: agent, type: 'fyi', order, needs_reply: false,
      body: `중계하지 않은 편지 ${rejected.length}통:\n${rejected.map((r) => `- ${r.path}: ${r.reason}`).join('\n')}`.slice(0, 4000),
    });
  }
  return { sent, rejected };
}

// 조각 브랜치에서 outbox 편지를 꺼내 옮기고, 코드 쪽(조각 브랜치)에서는 지운다.
export async function relayBranch({ repoDir, base, branch, agent, order, mailbox, runDir, worktreeDir, remove = true, isStopped = () => false }) {
  if (isStopped()) return { sent: [], rejected: [], stopped: true };
  await withRepoLock(repoDir, () => fetchBranch(repoDir, branch));
  const ref = `refs/remotes/origin/${branch}`;
  const out = await git(repoDir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--diff-filter=AM', `${base}...${ref}`, '--', OUTBOX_PREFIX]);
  const paths = out.split('\0').filter((p) => p && p !== DONE_FILE); // done.md는 끝내기 표시(편지 아님)
  const items = [];
  for (const p of paths) {
    items.push({ path: p, content: await git(repoDir, ['show', `${ref}:${p}`]) });
  }
  if (isStopped()) return { sent: [], rejected: [], stopped: true };
  const res = await deliver({ items, agent, order, mailbox, runDir });
  const tracked = await git(repoDir, ['ls-tree', '-r', '-z', '--name-only', ref, '--', OUTBOX_PREFIX]);
  if (remove && !isStopped() && tracked.split('\0').filter(Boolean).length) {
    await commitToBranch({
      repoDir, worktreeDir, branch,
      apply: async (wt) => { fs.rmSync(path.join(wt, '.trio', 'outbox'), { recursive: true, force: true }); },
      message: 'trio: 중계한 편지를 코드 쪽에서 뺀다',
    });
  }
  return res;
}

// Codex 결과 diff(문자열)에서 바로 옮긴다.
export async function relayPatch({ patch, agent, order, mailbox, runDir }) {
  const items = outboxFilesFromPatch(patch).filter((f) => f.path !== DONE_FILE).map((f) => ({ path: f.path, content: f.content }));
  return deliver({ items, agent, order, mailbox, runDir });
}
