# ai-trio-relay

> **상태: 개발 중(v0.1 MVP 전).** 아직 실제로 쓸 수 있는 단계가 아니다. 설계는 [PRD.md](PRD.md)에 있다.

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

## 준비(예정)
- **Claude Code**: claude.ai 계정으로 로그인. 대상 저장소에 Claude GitHub App을 설치한다.
- **Codex**: 대상 저장소의 클라우드 환경을 만들고 Publish한다. Codex CLI에 로그인한다.
- **Antigravity**: `agy` CLI에 로그인한다.
- **GitHub**: `gh` CLI에 로그인한다.

> ⚠️ **공개 저장소에서 쓰면 전달함 브랜치와 작업 브랜치도 공개된다.** 작업 대상은 비공개 저장소를 권한다.

## 영어 요약 (English summary)
A Claude Code skill that runs **Claude Code on the web, Codex cloud, and Antigravity in parallel**.
- Claude Code acts as the orchestrator: it splits a goal into non-overlapping work orders, commits a shared contract first, and starts each agent on its own branch.
- The agents talk to each other through a **mailbox branch** on GitHub, with no human relay.
- Each work order is cross-reviewed by a model from a different vendor, and passing work is merged one piece at a time.
- Status: work in progress. See [PRD.md](PRD.md).

## 라이선스
MIT
