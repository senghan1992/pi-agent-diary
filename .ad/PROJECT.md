# agent-diary

## What & why
코딩 에이전트(pi, Claude Code)가 프로젝트별 `.ad/`에 한 일과 이유를 스스로 기록하고, 새 세션이 그 기록으로 맥락을 바로 복원하게 하는 오픈소스 도구(npm: pi-agent-diary).
핵심 제약: 기록이 늘어도 세션 시작 비용은 고정(budgets.context), 사용자는 아무것도 안 해도 됨.

## Architecture
- `src/core/` — 에이전트 무관 라이브러리
  - store(.ad 포맷·저널·인덱스), decisions(D# id·pin·supersede), recall(BM25+한글 bigram), compact(map-reduce 롤업), context(세션 번들), session(기계적 세션 사실), lock(프로세스 간 락), config
- `src/pi/extension.ts` — pi: 시스템 프롬프트 섹션 주입, 프롬프트별 recall, 수정 집계, agent_before_settle 넛지, 백그라운드 롤업, diary_* 도구, /diary
- `src/cli.ts` + `bin/ad.js` — CLI와 Claude Code 훅(`ad hook …`). npm 설치 시 dist/, 체크아웃에선 src/ 직접 실행
- `skills/agent-diary/` — 작성 가이드(지연 로딩), `integrations/claude-code/` — 훅 설정

## How to run / test
- `npm run check` (typecheck + node:test 39개), `npm run build`, `pi -e ./src/pi/extension.ts`
- 실환경 확인: 임시 git 저장소에서 `pi -p --no-session … </dev/null` (stdin 닫기 필수), `AGENT_DIARY_DEBUG=1`

## Conventions
- erasable TS만, `.ts` 확장자 import — Node 타입 스트리핑과 jiti 모두 지원. 런타임 의존성 0
- 모든 훅은 실패해도 세션을 깨지 않음(safe / exit 0). 공유 파일 RMW는 locked(), 전체 쓰기는 write-then-rename
- 포맷·규칙은 core에만, extension/CLI는 얇게. 동작 변경은 테스트(특히 extension 하네스)와 함께
