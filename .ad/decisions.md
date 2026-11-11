# Decisions

<!-- agent-diary · one line per decision, oldest first. ★ = pinned (always loaded), ~~struck~~ = superseded.
     Written by diary_write and roll-ups; edit by hand only to fix wording. -->

- [D1] 2026-11-06 · extension+skill+library 조합 — 자동 동작은 훅, 작성법은 지연 로딩 skill, 포맷은 core 한 곳 (rejected: skill 단독은 모델이 잊으면 끝) — [[2026-11-06]]
- [D2] 2026-11-06 · 주입은 chat 메시지가 아닌 시스템 프롬프트 섹션 — compaction에 살아남고 세션 동안 고정해 prompt cache 유지 — [[2026-11-06]]
- [D3] 2026-11-06 · PROJECT/STATUS는 하드 예산 초과 시 쓰기 거부 — 덧붙이기 대신 다시 쓰기(curation)를 강제 — [[2026-11-06]]
- [D4] 2026-11-06 · 오래된 달은 digest로 롤업하고 원본은 삭제 대신 archive로 이동 — 검색 가능성 유지 — [[2026-11-06]]
- [D5] 2026-11-11 · recall은 BM25+CJK bigram — 의존성 0 (rejected: 임베딩 기본) — [[2026-11-11]]
- [D6] ★ 2026-11-11 · 훅 실패가 세션을 깨면 안 됨 — 경고 1회 후 계속 — [[2026-11-11]]
- [D7] 2026-11-11 · 넛지는 수정 6회 또는 파일 2개 — 실측에서 3파일 기능이 누락됨 — [[2026-11-11]]
- [Df1b59] 2026-11-11 · 결정 id는 5자리 내용 해시 — 브랜치 간 충돌 불가 (rejected: 카운터 유지 + 병합 후 재번호) — [[2026-11-11]]
- [Da3yz7] 2026-11-11 · union merge로 append-only 파일 병합 — git 내장, 사용자 설정 불필요 — [[2026-11-11]]
- [Dzl7l4] 2026-11-11 · index.md는 사람용 보기 — 에이전트는 항상 journal을 직접 읽으므로 증분 갱신이 어긋나도 정확성에 영향 없음 — [[2026-11-11]]
