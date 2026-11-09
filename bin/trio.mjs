#!/usr/bin/env node
// trio — Claude Code 웹 · Codex 웹 · Antigravity 병렬 실행 도구의 명령줄.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run as runCmd, repoRoot, git } from '../lib/gitops.mjs';
import { runDirFor, readJson, writeJson, readLedger } from '../lib/ledger.mjs';
import { loadState, formatStatus, saveState, isStopped } from '../lib/status.mjs';
import { preparePlan, approvePlan, runPlan, stopRun, makeHeadMailbox, recordLeaseApproval, mergePassed, recordReview, whenIdle } from '../lib/run.mjs';
import { relayBranch, relayPatch } from '../lib/relay.mjs';
import { createClaudeWebAdapter } from '../lib/adapters/claude-web.mjs';
import { createCodexWebAdapter } from '../lib/adapters/codex-web.mjs';
import { createAntigravityLocalAdapter } from '../lib/adapters/antigravity-local.mjs';
import { parseLeasePaths, ID_RE } from '../lib/orders.mjs';

const HELP = `trio — 세 에이전트 병렬 실행 · 전달함 · 교차 검토

  trio init [--codex-env <환경ID>]          준비 4항목 점검(✅/❌) · .trio/config.json 저장
  trio plan --file plan.json [--run <이름>]  계획 검증 → 승인 대기
  trio approve <실행>                        계획 승인(사람)
  trio run <실행> [--poll <ms>]              조각 동시 시작 → 중계 → 범위 → 검토 → 병합 줄
  trio status <실행>                         조각 상태 표
  trio mail send --run <실행> --from <a> --to <b> --type <t> [--re <편지>] [--needs-reply] [--order <조각>] (--body <글> | --body-file <파일>)
  trio mail read --run <실행> --to <b> [--peek]
  trio relay <실행> <조각> [--patch <diff 파일>]
  trio lease <실행> <조각> --re <편지> [--deny]        임대 판단(HEAD) — 돌고 있는 trio run이 반영한다
  trio review <실행> <조각> [--file <검토 JSON>]       검토 기록 보기 · 수동 검토 결과 넣기(fail-closed)
  trio merge <실행> [--pr]                    통과 조각 병합 줄 · --pr이면 integration → main PR(병합은 사람)
  trio stop <실행>                            전부 정지(STOPPED · 자동 재개 없음)
`;

function out(s = '') { process.stdout.write(`${s}\n`); }
function die(msg, code = 1) { process.stderr.write(`trio: ${msg}\n`); process.exit(code); }

async function ctx(runName, piece) {
  const repoDir = await repoRoot(process.cwd());
  if (runName !== undefined && !ID_RE.test(runName || '')) die(`실행 이름 "${runName}" 형식이 바르지 않다`);
  if (piece !== undefined && !ID_RE.test(piece || '')) die(`조각 이름 "${piece}" 형식이 바르지 않다`);
  const config = readJson(path.join(repoDir, '.trio', 'config.json'), {});
  const remote = (await git(repoDir, ['remote', 'get-url', 'origin'], { allowFail: true })) || '';
  return { repoDir, config, runDir: runName ? runDirFor(repoDir, runName, remote.trim()) : null };
}

export async function checkReady({ exec = runCmd, cwd = process.cwd(), config = {} } = {}) {
  const tryRun = async (cmd, args) => {
    try { return { ok: true, out: (await exec(cmd, args, { cwd })).stdout }; } catch (err) { return { ok: false, out: `${err.stderr || err.message}` }; }
  };
  const items = [];
  const claude = await tryRun('claude', ['--version']);
  items.push({ name: 'Claude Code 웹', ok: claude.ok, fix: 'Claude Code CLI 설치 → `claude auth login`(claude.ai 계정) → 대상 저장소에 Claude GitHub App 설치(또는 `/web-setup`). https://code.claude.com/docs' });
  const codex = await tryRun('codex', ['--version']);
  const envOk = !!(config.codex && config.codex.envId);
  items.push({ name: 'Codex 웹', ok: codex.ok && envOk, fix: `${codex.ok ? '' : 'Codex CLI 0.167+ 설치 · 로그인. '}${envOk ? '' : 'chatgpt.com Codex에서 이 저장소의 클라우드 환경을 만들고 Publish → `trio init --codex-env <환경ID>`. '}https://developers.openai.com/codex/cloud` });
  const agy = await tryRun('agy', ['--version']);
  items.push({ name: 'Antigravity(로컬 agy)', ok: agy.ok, fix: 'agy 1.4.x 설치 · 로그인(Google AI Pro 이상). https://antigravity.google' });
  const gh = await tryRun('gh', ['auth', 'status']);
  const remote = await tryRun('git', ['remote', 'get-url', 'origin']);
  const isGithub = remote.ok && /github\.com[:/]/i.test(remote.out);
  items.push({ name: 'GitHub', ok: gh.ok && isGithub, fix: `${gh.ok ? '' : '`gh auth login`. '}${isGithub ? '' : 'origin 원격이 GitHub 저장소여야 한다(웹 에이전트가 GitHub에서 clone한다). '}` });
  let visibility = null;
  if (gh.ok && isGithub) {
    const v = await tryRun('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility']);
    if (v.ok) visibility = v.out.trim().toUpperCase();
  }
  return { items, visibility };
}

export function formatReady({ items, visibility }) {
  const lines = items.map((i) => `${i.ok ? '✅' : '❌'} ${i.name}${i.ok ? '' : `\n   고치는 법: ${i.fix.trim()}`}`);
  if (visibility === 'PUBLIC') lines.push('⚠️  공개 저장소다. 전달함 브랜치(trio/mailbox)와 조각 브랜치도 모두에게 보인다. 비공개 저장소를 권한다.');
  lines.push(
    '⚠️  병합 줄의 verify는 에이전트가 쓴 코드를 이 PC에서 실행한다(환경 변수는 최소만 넘긴다). 믿지 못할 저장소에서는 쓰지 않는다.',
    '⚠️  GitHub Actions가 trio/** 브랜치 푸시로 돌지 않게 워크플로의 branches-ignore에 trio/**를 넣는다. main · trio/*/base · trio/*/integration은 브랜치 보호를 켠다.',
  );
  return lines.join('\n');
}

function realAdapters({ repoDir, runDir, config, mailbox }) {
  return {
    claude: createClaudeWebAdapter({ repoDir, runDir, config, mailbox }),
    codex: createCodexWebAdapter({ repoDir, runDir, config }),
    antigravity: createAntigravityLocalAdapter({ repoDir, runDir, config }),
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return out(HELP);

  if (cmd === 'init') {
    const { values } = parseArgs({ args: rest, options: { 'codex-env': { type: 'string' } } });
    const { repoDir, config } = await ctx();
    if (values['codex-env']) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(values['codex-env'])) die('환경 ID 형식이 바르지 않다');
      config.codex = { ...(config.codex || {}), envId: values['codex-env'] };
      writeJson(path.join(repoDir, '.trio', 'config.json'), config);
      out('저장: .trio/config.json');
    }
    const r = await checkReady({ cwd: repoDir, config });
    out(formatReady(r));
    process.exitCode = r.items.every((i) => i.ok) ? 0 : 2;
    return;
  }

  if (cmd === 'plan') {
    const { values } = parseArgs({ args: rest, options: { file: { type: 'string' }, run: { type: 'string' } } });
    if (!values.file) die('--file plan.json이 필요하다');
    const plan = JSON.parse(fs.readFileSync(values.file, 'utf8'));
    const run = values.run || plan.run;
    if (!run) die('실행 이름이 없다(--run 또는 plan.run)');
    plan.run = run;
    const { runDir, config } = await ctx(run);
    const res = preparePlan({ runDir, plan, run, maxPieces: config.maxPieces });
    if (!res.ok) die(`계획이 바르지 않다:\n- ${res.errors.join('\n- ')}`, 2);
    out(`계획 ${run}: 조각 ${plan.pieces.length}개`);
    for (const p of plan.pieces) out(`- ${p.id} · ${p.agent} · ${p.allowed_paths.join(', ')}${p.deps && p.deps.length ? ` · 의존 ${p.deps.join(',')}` : ''}`);
    out(`승인 대기 — 사람이 확인한 뒤 \`trio approve ${run}\``);
    return;
  }

  if (cmd === 'approve') {
    const { runDir } = await ctx(rest[0]);
    const s = approvePlan(runDir);
    out(`승인: ${s.run} (${s.approved.hash.slice(0, 12)})`);
    return;
  }

  if (cmd === 'run') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { poll: { type: 'string' } } });
    const run = positionals[0];
    const { repoDir, runDir, config } = await ctx(run);
    const mailbox = makeHeadMailbox(repoDir, runDir, run);
    const adapters = realAdapters({ repoDir, runDir, config, mailbox });
    const res = await runPlan({
      repoDir, runDir, adapters, mailbox, pollMs: Number(values.poll || 15000),
      onEvent: (e) => out(`[${e.ts || new Date().toISOString()}] ${e.agent} ${e.piece} ${e.action} ${e.result}`),
    });
    out(`끝: ${res.status}`);
    for (const [id, st] of Object.entries(res.pieces)) out(`- ${id}: ${st}`);
    return;
  }

  if (cmd === 'status') {
    const run = rest[0];
    const { repoDir, runDir, config } = await ctx(run);
    const state = loadState(runDir);
    let heartbeats = {};
    try { heartbeats = await makeHeadMailbox(repoDir, runDir, run).readHeartbeats(); } catch { /* 원격에 못 닿으면 로컬 상태만 */ }
    out(formatStatus(state, { heartbeats, stallMinutes: config.stallMinutes || 30 }));
    return;
  }

  if (cmd === 'mail') {
    const sub = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        run: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' },
        re: { type: 'string' }, 'needs-reply': { type: 'boolean' }, order: { type: 'string' },
        body: { type: 'string' }, 'body-file': { type: 'string' }, peek: { type: 'boolean' },
      },
    });
    const { repoDir, runDir } = await ctx(values.run);
    const mb = makeHeadMailbox(repoDir, runDir, values.run);
    if (sub === 'send') {
      const body = values['body-file'] ? fs.readFileSync(values['body-file'], 'utf8') : (values.body ?? '');
      // 실행 루프가 도는 동안에는 보내지 않는다(HEAD 기록 파일을 다른 프로세스가 바꾸면 루프가 무결성 검사로 멈춘다).
      const s = await whenIdle(runDir, () => mb.send({ from: values.from, to: values.to, type: values.type, re: values.re || '', needs_reply: !!values['needs-reply'], order: values.order || '', body }));
      out(`보냄: ${s.path}`);
      return;
    }
    if (sub === 'read') {
      const letters = values.peek ? await mb.peek(values.to) : await mb.readNew(values.to);
      if (!letters.length) out('새 편지 없음');
      for (const l of letters) out(`── ${l.name}\n${l.broken ? `(깨진 편지: ${l.broken})` : `from ${l.from} · type ${l.type} · order ${l.order || '-'} · re ${l.re || '-'} · 답 필요 ${l.needs_reply}\n${l.body}`}`);
      return;
    }
    die('mail send | read');
  }

  if (cmd === 'relay') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { patch: { type: 'string' } } });
    const [run, piece] = positionals;
    const { repoDir, runDir } = await ctx(run, piece);
    if (isStopped(runDir)) die('이 실행은 정지(STOPPED)됐다 — 중계하지 않는다');
    const order = readJson(path.join(runDir, 'orders', `${piece}.json`));
    const state = loadState(runDir);
    if (!order || !state || !state.baseSha) die(`조각 ${piece}의 ORDER 또는 base 기록이 없다`);
    const mailbox = makeHeadMailbox(repoDir, runDir, run);
    const res = await whenIdle(runDir, () => (values.patch
      ? relayPatch({ patch: fs.readFileSync(values.patch, 'utf8'), agent: order.agent, order: piece, mailbox, runDir })
      : relayBranch({ repoDir, base: state.baseSha, branch: order.branch, agent: order.agent, order: piece, mailbox, runDir, worktreeDir: path.join(runDir, 'worktrees', `relay-${piece}`), isStopped: () => isStopped(runDir) })));
    out(`중계 ${res.sent.length}통 · 거부 ${res.rejected.length}통${res.stopped ? ' · 정지되어 멈춤' : ''}`);
    for (const r of res.rejected) out(`- 거부 ${r.path}: ${r.reason}`);
    return;
  }

  if (cmd === 'lease') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { re: { type: 'string' }, deny: { type: 'boolean' } } });
    const [run, piece] = positionals;
    const { repoDir, runDir } = await ctx(run, piece);
    if (!values.re) die('--re <편지 이름>이 필요하다(head 상자의 lease-request)');
    const mailbox = makeHeadMailbox(repoDir, runDir, run);
    const letter = (await mailbox.list('head')).find((l) => l.name === values.re);
    if (!letter || letter.broken) die(`head 상자에 편지 ${values.re}가 없다(또는 깨졌다)`);
    if (letter.type !== 'lease-request' || letter.order !== piece) die(`편지 ${values.re}는 조각 ${piece}의 lease-request가 아니다`);
    const paths = parseLeasePaths(letter.body);
    recordLeaseApproval(runDir, { letter: letter.name, decision: values.deny ? 'deny' : 'grant', paths });
    out(`임대 ${values.deny ? '거부' : '승인'} 기록: ${piece} ← ${paths.join(', ') || '(경로 없음)'} — 돌고 있는 trio run이 다음 순번에 반영한다`);
    return;
  }

  if (cmd === 'review') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { file: { type: 'string' } } });
    const [run, piece] = positionals;
    const { repoDir, runDir } = await ctx(run, piece);
    if (values.file) {
      const r = await recordReview({ repoDir, runDir, run, piece, text: fs.readFileSync(values.file, 'utf8'), mailbox: makeHeadMailbox(repoDir, runDir, run) });
      out(`검토 ${piece}: ${r.verdict} (${r.reason})`);
      return;
    }
    const recs = readJson(path.join(runDir, 'reviews', `${piece}.json`), []);
    if (!recs.length) out('검토 기록 없음');
    for (const r of recs) out(`${r.round}회차 · 검토자 ${r.reviewer} · ${r.verdict} (${r.reason}) · 지적 ${r.findings.length}건`);
    return;
  }

  if (cmd === 'merge') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { pr: { type: 'boolean' } } });
    const run = positionals[0];
    const { repoDir, runDir } = await ctx(run);
    const merges = await mergePassed({ repoDir, runDir, run, mailbox: makeHeadMailbox(repoDir, runDir, run) });
    for (const m of merges) out(`- ${m.id}: ${m.state}`);
    if (values.pr && merges.some((m) => m.state === 'MERGED')) {
      const plan = readJson(path.join(runDir, 'plan.json'));
      const { stdout } = await runCmd('gh', ['pr', 'create', '--base', plan.base || 'main', '--head', `trio/${run}/integration`, '--title', `trio ${run}: ${plan.goal}`.slice(0, 120), '--body', `trio 실행 ${run}의 병합 줄 결과다. 병합은 사람이 한다.\n\n${merges.map((m) => `- ${m.id}: ${m.state}`).join('\n')}`], { cwd: repoDir });
      out(stdout.trim());
    }
    return;
  }

  if (cmd === 'stop') {
    const run = rest[0];
    const { repoDir, runDir, config } = await ctx(run);
    const mailbox = makeHeadMailbox(repoDir, runDir, run);
    const res = await stopRun({ runDir, adapters: realAdapters({ repoDir, runDir, config, mailbox }) });
    out(`정지(STOPPED): 프로세스 ${res.killed.length}개 종료 · 웹 세션 정지 메시지 ${res.messaged.length}건`);
    for (const u of res.unknown) out(`- ${u}`);
    const state = loadState(runDir);
    if (state) saveState(runDir, state);
    return;
  }

  if (cmd === 'ledger') {
    const { runDir } = await ctx(rest[0]);
    for (const e of readLedger(runDir)) out(JSON.stringify(e));
    return;
  }

  die(`모르는 명령 "${cmd}"\n${HELP}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((err) => die(err && err.message ? err.message : String(err)));
}

