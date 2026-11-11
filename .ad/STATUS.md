# Status

## Now
- v0.2.0 품질 개선 완료: recall, 결정 id/고정/대체, 일기 한 편 예산, map-reduce 자동 롤업, 동시성 락, 파일 수 기반 넛지, Claude Code 훅 고도화, 영/한 README·DESIGN·CHANGELOG·CI. 테스트 39개 통과, 실제 pi에서 기록·recall·롤업 확인.

## Next
- GitHub 저장소 생성 후 package.json repository.url의 OWNER 교체, npm publish
- 실제 Claude Code 세션에서 훅 검증
- 몇 주 실사용 후 recall.minScore, nudge 임계값 튜닝

## Open questions
- recall이 lexical로 충분한지, 임베딩 백엔드가 필요한지
- LICENSE 저작권자 표기("agent-diary contributors")를 실명으로 바꿀지
