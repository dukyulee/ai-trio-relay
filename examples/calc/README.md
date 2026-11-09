# examples/calc — trio 3조각 예시

작은 계산기다. 계약 파일 `src/types.js`(+ 그 시험)만 있고, 나머지 세 파일은 조각이 만든다.

| 조각 | 담당 | 고쳐도 되는 파일 |
|---|---|---|
| add | claude | `src/add.js` · `test/add.test.js` |
| mul | codex | `src/mul.js` · `test/mul.test.js` |
| format | antigravity | `src/format.js` · `test/format.test.js` (add · mul에 의존) |

이 폴더를 새 GitHub 저장소로 올린 뒤 `trio plan --file plan.json` → `trio approve` → `trio run`으로 돌린다.
전체 시험은 `node --test "test/*.test.js"`이다.
