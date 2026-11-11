# ai-trio-relay

> **상태: v0.1 MVP — 가짜 어댑터 + 로컬 bare 저장소로 전 구간 시험만 통과했다.** 실제 웹 실행(Claude 웹 · Codex 웹)은 아직 확인 전이다([docs/verified.md](docs/verified.md)). 설계는 [PRD.md](PRD.md)에 있다.

Claude Code 웹 · Codex 웹 · Antigravity를 **병렬로** 일하게 하는 Claude Code 스킬이다. 셋은 GitHub의 **전달함 브랜치**로 사람을 거치지 않고 서로 묻고 답한다.

```
목표 한 줄 ─▶ HEAD(이 PC의 Claude Code)가 조각(ORDER)으로 나누고 공통 계약을 먼저 커밋
              │
     ┌────────┼──────────────┐
     ▼        ▼              ▼
 Claude 웹   Codex 웹     Antigravity(로컬 agy)     ← 각자 자기 브랜치에서 동시에 구현
     │        │              │
     └──── trio/mailbox 브랜치(전달함) ────┘         ← 요청 · 질문 · 임대 요청 · 답장
              │
   다른 회사 모델이 돌려 막기로 교차 검토 → 통과한 조각만 하나씩 합치기 → main PR(병합은 사람)
```

## 무엇이 다른가
- **전달함**: 에이전트끼리 편지(파일 1개 = 편지 1통)로 직접 주고받는다. 사람이 요청을 옮겨 나르지 않는다.
- **계약 먼저**: 공유 타입 · 인터페이스를 먼저 커밋하고, 모든 조각이 그 위에서 시작한다.
- **범위 강제**: 조각마다 고쳐도 되는 파일(`allowed_paths`)이 있다. 밖을 고치면 FAIL이다(fail-closed).
- **교차 검토**: 작성자와 다른 회사 모델이 검토한다(Claude→Codex→Antigravity→Claude).
- **병합 줄**: 통과한 조각을 하나씩 합치며 매번 시험을 돌린다.

## 준비
- **Claude Code**: claude.ai 계정으로 로그인. 대상 저장소에 Claude GitHub App을 설치한다.
- **Codex**: 대상 저장소의 클라우드 환경을 만들고 Publish한다. Codex CLI에 로그인한다.
- **Antigravity**: `agy` CLI에 로그인한다.
- **GitHub**: `gh` CLI에 로그인한다.

> ⚠️ **공개 저장소에서 쓰면 전달함 브랜치와 작업 브랜치도 공개된다.** 작업 대상은 비공개 저장소를 권한다.

### 대상 저장소에 한 번 해 둘 보안 설정
- **GitHub Actions를 trio 브랜치에서 빼라.** 조각 브랜치에는 에이전트가 쓴 코드가 올라간다. 워크플로가 그 푸시로 돌면 저장소 비밀값(secrets)으로 남의 코드를 실행한다. 모든 워크플로의 `on.push`에 `branches-ignore: ['trio/**']`를 넣는다(`pull_request`도 같다).
- **브랜치 보호**를 켠다: `main`(사람만 병합), `trio/*/base` · `trio/*/integration`(강제 푸시 · 삭제 금지). trio는 base · integration을 HEAD가 만든 SHA와 대조해 다르면 멈추지만, 보호가 먼저다.
- **병합 줄의 verify는 이 PC에서 에이전트가 쓴 코드를 실행한다.** 환경 변수는 최소(PATH · HOME · SystemRoot 등)만 넘기지만 파일 접근은 막지 못한다. 믿지 못할 저장소 · 계획에는 쓰지 않는다.

## 설치
- Node.js 24 이상. 의존성 없음(표준 라이브러리만).
- Claude Code 플러그인: `/plugin marketplace add dukyulee/ai-trio-relay` → `trio` 스킬.
- 명령줄만 쓸 때: 이 저장소를 받아 `node bin/trio.mjs <명령>`(또는 `npm link` 뒤 `trio`).

## 사용법
작업 대상 저장소(GitHub에 있어야 한다)의 루트에서 부른다.

```
trio init [--codex-env <환경ID>]          # 준비 4항목 ✅/❌ · Codex 환경 ID를 .trio/config.json에 저장
trio plan --file plan.json                # 계획 검증 → 승인 대기(이때까지 아무것도 시작하지 않는다)
trio approve <실행>                        # 사람이 승인
trio run <실행>                            # 동시 시작 → 중계 → 범위 검사 → 교차 검토 → 병합 줄
trio status <실행>                         # 조각 상태 표
trio mail read --run <실행> --to head      # HEAD 상자 읽기(임대 요청 등)
trio lease <실행> <조각> --re <편지> [--deny]  # 임대 판단(HEAD) — 돌고 있는 trio run이 반영
trio merge <실행> --pr                     # integration → main PR(병합은 사람)
trio stop <실행>                           # 전부 정지(STOPPED · 자동 재개 없음)
```

- 계획 파일 예시: [examples/calc/plan.json](examples/calc/plan.json) — 계약 `src/types.js` 위에서 3조각(add · mul · format).
- 설정 `.trio/config.json`: `codex.envId`(필수), `codex.status`(상태 글 정규식 — 확인 전에는 비워 둔다), `claude.canPushMailbox`(기본 **false** — 확인 C1 뒤 켠다), `maxPieces`(기본 3), `stallMinutes`(기본 30).
- 에이전트당 조각은 하나다(상자 · 하트비트 · 검토자 돌려 막기가 에이전트 단위).
- 로컬 실행 기록: `~/.trio/runs/<저장소>-<원격 해시>-<실행>/`(원장 `ledger.jsonl` · 세션 ID 표 · 검토 기록 · 결정 게시판 사본 · 로그). Antigravity(로컬 agy) 작업 폴더는 OS 임시 폴더 아래 무작위 이름(`trio-agent-…`, 실행 폴더와 다른 트리)이고 git 메타가 없다. 저장소에는 커밋하지 않는다.
- `trio run`이 도는 동안 `trio merge` · `trio review --file`은 거절된다(실행 잠금). 실행 폴더의 계획 · ORDER · 상태 파일이 HEAD 모르게 바뀌면 실행은 ABORTED로 멈춘다.
- 범위 훅(선택): `templates/hooks/order-scope-guard.mjs`를 대상 저장소 `.claude/hooks/`에 넣고 파일 안의 설정 예를 `.claude/settings.json`에 넣는다.
- 시험: `npm test`(가짜 어댑터 + 한글 · 공백 경로의 로컬 bare 저장소).

## 한계(v0.1)
- 실제 웹 실행의 출력 형식 · 상태 확인 · 정지 방법은 확인 전이다. 어댑터가 세션 · 작업 ID를 못 찾으면 원문을 로그에 두고 그 조각을 FAILED로 둔다(추측하지 않는다).
- Codex 웹 작업은 취소 방법을 모른다. `trio stop`은 결과를 쓰지 않을 뿐 작업을 끊지 못한다.
- 한도 넘김(다른 에이전트에게 다시 맡기기)은 v0.2다. 지금은 LIMIT 상태로 멈춘다.
- 계획 파일 · 설정 · ORDER는 YAML이 아니라 JSON이다(의존성 0).
- Codex 상태 글(`codex cloud status`)은 형식 확인(X2) 전까지 해석하지 않는다. 설정 `codex.status`가 없으면 Codex 조각은 「모름」으로 기다리다 정해진 횟수 뒤 FAILED가 된다.
- 비밀값 검사는 알려진 토큰 모양과 `이름=값` 꼴만 본다. 낯선 형식 · 나눠 쓴 비밀값 · 인코딩한 비밀값은 못 잡는다. 공개 저장소에서는 전달함 내용 전체를 공개 글로 생각한다.
- 전달함 감사에서 누가 했는지 모르는 위반(자기 편지 없이 남의 것을 고친 커밋 · 병합 · 루트 커밋 · 역사 고침 · 감사 실패 · 커밋 500개 초과)이 나오면 실행 전체가 MAILBOX_TAMPERED로 멈추고 모든 조각이 사람에게 간다. 기본 설정(직접형 0명)에서는 HEAD 밖의 모든 커밋이 이렇게 된다.
- 중계형 에이전트(Codex · agy · 기본 Claude)의 임대는 작업이 끝날 때 HEAD가 바로 판단할 수 있어야 한다. 판단이 늦으면 그 조각은 빌린 파일 없이 범위 검사로 간다.
- `trio lease`는 판단만 기록한다(돌고 있는 `trio run`이 반영). 실행 루프는 승인 기록이 「뒤에만 붙는지」만 본다 — 실행 폴더(`~/.trio/runs/…`)에 쓸 수 있는 프로세스는 자기 임대를 스스로 승인하는 줄을 붙일 수 있다. 다른 제어 파일(계획 · ORDER · 상태 · 세션 표 · 감사 기록 · 결정 사본 · 중계 기록)은 HEAD가 마지막으로 쓴 해시와 다르면 ABORTED로 멈추지만, 읽기(세션 ID 등)는 막지 못한다.
- **Antigravity(로컬 agy)는 실험 기능이고 기본으로 꺼져 있다**(확인 A1 · 2026-11-11 · agy 1.5.3). `--sandbox`는 터미널만 막는다(헤드리스에서 명령은 자동 거부 — git push도). **파일 도구는 작업 폴더 밖 절대 경로를 그대로 읽고 쓴다.** 그래서 켜지 않으면 agy 조각이 든 계획은 `trio plan`에서 거부되고, 검토 돌려 막기도 agy를 건너뛴다(Codex 조각은 Claude가 검토). 켜는 법은 아래 「Antigravity 켜기」.
- `trio run`이 도는 동안 `trio mail send` · `trio relay` · `trio merge` · `trio review --file`은 거절된다(실행 루프가 쓰는 기록을 다른 프로세스가 바꾸지 않게). 임대 판단은 `trio lease`, 정지는 `trio stop`.
- HEAD가 전달함에 푸시한 직후 그 커밋을 기록하기 전에 죽으면, 다음 감사에서 그 커밋은 「누가 했는지 모르는 커밋」으로 걸려 실행이 멈춘다(fail-closed). 사람이 전달함을 확인하고 새 실행 이름으로 다시 한다.
- 범위 훅(`templates/hooks/order-scope-guard.mjs`)은 Claude의 편집 도구(Edit · Write 등)만 본다. Bash로 쓴 파일은 편집 순간에 막지 못하고, 작업 뒤 범위 검사(fail-closed)에서만 잡힌다.
- `.trio/orders/*.json`(조각 범위 · 임대 기록. 임대 사유에 편지 본문 앞부분이 들어간다)은 integration을 거쳐 main PR에도 실린다. 공개 저장소에서는 이 내용도 공개된다.
- **agy 가져오기의 알려진 문제(v0.2에서 고친다 — 그 전까지 agy는 실험):**
  - 개수 · 크기 상한이 gitignore 대상(`node_modules` · `.venv` · `dist`)까지 센다. 에이전트가 폴더에서 `npm install`을 하면 정상 작업도 FAIL할 수 있다.
  - 파일 종류 확인(lstat)과 복사 사이에 틈이 있고, 하드 링크를 가려내지 않는다. agy가 남긴 자식 프로세스가 그 틈에 파일을 링크로 바꾸면 폴더 밖 내용을 가져올 수 있다.
  - Windows 파일 이름 별칭(대소문자 충돌 · 이름은 달라도 같은 파일로 열리는 경우)은 확인하지 않았다. 예약 이름(`CON` · `NUL`) · 긴 경로는 그 조각이 FAILED가 된다.
- 잠금 파일(`~/.trio/runs/…/*.lock`)은 주인 프로세스가 살아 있으면 오래돼도 빼앗지 않는다. 주인이 멈춘 채 살아 있으면 사람이 그 프로세스를 끝내거나 잠금 파일을 지운다.
- 에이전트 · verify 환경은 허용 목록이다. Node · npm 밖 도구(Java · Go · Python 가상 환경 · 사내 CA)에 필요한 변수는 아직 넘기지 않는다.

## Antigravity 켜기 (실험)
agy의 파일 경계는 `--sandbox`가 아니라 agy 권한 규칙(`~/.gemini/antigravity-cli/settings.json`의 `permissions` · Deny > Ask > Allow)이 정한다. 켜기 전에 셋을 한다.

1. **민감 경로를 deny 규칙으로 막는다.** `read_file`을 막으면 같은 경로의 `write_file`도 막힌다(공식 문서). 적어도 아래를 넣는다. Windows는 agy가 경로를 `/`로 바꾸고 드라이브 문자를 뺀 뒤 비교한다.
   - 실행 기록: `~/.trio`
   - 자격 증명: `~/.ssh` · `~/.config/gh` · `~/.codex` · `~/.claude` · `~/.gemini` · `~/.aws` · `~/.npmrc` · `~/.gitconfig`
   - 다른 저장소가 있는 작업 폴더
2. **막혔는지 직접 확인한다.** `docs/verified.md` A1의 방법대로, 작업 폴더 밖 카나리 파일 읽기 · 쓰기를 agy에게 시켜 본다. 실패해야 한다. 이 확인은 아직 하지 않았다(권한 규칙 적용 결과는 미확인).
3. `.trio/config.json`에 `"antigravity": { "experimental": true }`를 넣는다(정확히 `true`일 때만 켜진다).

## 영어 요약 (English summary)
A Claude Code skill that runs **Claude Code on the web, Codex cloud, and Antigravity in parallel**.
- Claude Code acts as the orchestrator: it splits a goal into non-overlapping work orders, commits a shared contract first, and starts each agent on its own branch.
- The agents talk to each other through a **mailbox branch** on GitHub, with no human relay.
- Each work order is cross-reviewed by a model from a different vendor, and passing work is merged one piece at a time.
- Status: v0.1 MVP — the full pipeline passes with mock adapters on a local bare repository; real web runs are not verified yet. See [PRD.md](PRD.md).
- Usage: `trio init` → `trio plan --file plan.json` → `trio approve <run>` → `trio run <run>` → `trio merge <run> --pr` (a human merges to main).

## 라이선스
MIT
