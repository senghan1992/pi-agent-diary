# agent-diary

**코딩 에이전트가 프로젝트 일기를 쓰고, 다음 세션은 이미 그 프로젝트를 알고 시작합니다.**

[English](README.md)

[pi](https://pi.dev)나 Claude Code로 프롬프트를 주며 개발하면 문서로 남는 게 거의 없습니다. 문서를 따로 정리할 필요도 없어야 합니다.
agent-diary는 에이전트가 **무엇을, 왜 했는지**를 저장소 안 `.ad/` 폴더에 직접 기록하게 합니다.
새 세션은 그 기록으로 프로젝트가 무엇인지, 지금 어디까지 왔는지, 무엇을 결정했는지, 최근 무슨 일이 있었는지를 작게 요약해 읽고 시작합니다.
오래된 기억은 지금 질문과 관련이 있을 때만 다시 떠오릅니다.

```
새 세션 시작 ──▶  PROJECT · STATUS · 고정/최근 결정 · 최근 7일 타임라인      (항상 ≤ 3,000 토큰)
프롬프트 입력 ──▶  + 이 프롬프트와 관련된 과거 기록이 있으면 함께          (≤ 450 토큰, 대개 0)
에이전트 작업 ──▶  수정 횟수만 기계적으로 집계 (LLM 비용 0) → 일이 쌓이면 짧은 일기 한 편
한 달이 지나면 ──▶  월간 요약으로 백그라운드 롤업, 원본은 archive에 남아 검색 가능
```

프로젝트마다 설정할 것도, 외울 명령도, 정리할 문서도 없습니다. 한 번 설치하고 평소처럼 코딩하면 됩니다.

## 설치

### pi

```bash
pi install npm:pi-agent-diary
```

이게 끝입니다. 에이전트가 파일을 수정하는 git 저장소마다 `.ad/`가 생기고 채워지기 시작합니다.

### Claude Code

```bash
npm install -g pi-agent-diary          # `ad` 명령 설치
```

[`integrations/claude-code/settings.json`](integrations/claude-code/settings.json)의 내용을 `~/.claude/settings.json`에 병합합니다.
작성 가이드도 쓰게 하려면 skill을 연결합니다.

```bash
mkdir -p ~/.claude/skills && ln -s "$(npm root -g)/pi-agent-diary/skills/agent-diary" ~/.claude/skills/agent-diary
```

`claude`가 PATH에 있으면 오래된 달의 요약은 `claude -p --model haiku`로 자동 실행됩니다.
다른 명령을 쓰려면 `.ad/config.json`의 `"summarizer"`를 설정하고, 끄려면 `AGENT_DIARY_SUMMARIZER=none`을 씁니다.

pi와 Claude Code는 같은 `.ad/`를 공유하므로 번갈아 써도 됩니다.

## 알아서 해 주는 일

| 시점 | 동작 | 비용 |
|---|---|---|
| 세션 시작 | PROJECT, STATUS, 고정/최근 결정, 7일 타임라인, 그리고 "이전 세션이 기록 없이 끝났음" 같은 알림을 시스템 프롬프트에 넣음 | 최대 3,000 토큰. 세션 동안 고정이라 prompt cache가 유지되고, 대화 압축에도 사라지지 않음 |
| 프롬프트 입력 | 그 프롬프트와 관련된 과거 일기, 결정, 월간 요약을 찾아 함께 넣음. 한국어는 글자 2개 단위로 비교해서 조사가 달라도 찾음 | 최대 450 토큰, 관련 없으면 0. 같은 기억은 세션당 한 번만 |
| 파일 수정 | 도구 이벤트로 수정 횟수만 셈 | 0 |
| 미기록 수정이 6회 쌓이거나 대화가 압축되기 직전 | 에이전트에게 보이지 않는 메시지로 한 번만 일기 작성을 요청. PROJECT/STATUS가 비었거나 오래됐으면 그것도 함께 | 짧은 1턴 |
| 일기 없이 세션 종료 | 그 세션의 프롬프트와 바뀐 파일이 `.ad/.local/`에 남고, 다음 세션이 보충 기록을 함 | 0 |
| 30일 지난 달 | 백그라운드에서 1,000 토큰 이하 요약으로 롤업. 긴 달은 나눠서 요약하므로 잘리지 않음. 여전히 중요한 결정은 고정하고, 무효가 된 결정은 취소선 처리 | 월 몇 번의 백그라운드 모델 호출 |

### "기록이 많아지면 컨텍스트를 다 잡아먹지 않나요?"

아닙니다. 이 프로젝트의 핵심 제약이고, 바람이 아니라 강제로 지킵니다.

- **하드 예산**: PROJECT ≤ 1,200, STATUS ≤ 600, 일기 한 편 ≤ 450, 월간 요약 ≤ 1,000, 고정 결정 ≤ 350 토큰.
  넘치면 쓰기가 **거부**되므로 에이전트는 덧붙이지 못하고 줄여서 다시 써야 합니다.
- **창 제한**: 최근 7일과 유효한 최신 결정 8개만 넣습니다. 대체된 결정은 빠집니다.
- **전체 상한**: 그래도 3,000 토큰을 넘으면 우선순위 낮은 섹션부터 잘립니다.
- **과거는 밀어 넣지 않고 꺼내 씀**: 그보다 오래된 기록은 관련도 검색으로만 불러옵니다.
- **롤업**: 30일이 지난 기록은 타임라인에서 한 달에 한 줄로 줄어듭니다.

테스트에서 1년치 일기를 넣고 세션 번들이 예산 안에 머무는지 검증합니다.

## `.ad/` 폴더

```
.ad/
├── PROJECT.md          무엇·왜, 구조, 실행/테스트 방법, 컨벤션          (정리해서 유지, 항상 로드)
├── STATUS.md           Now / Next / Open questions                      (덮어쓰기, 항상 로드)
├── decisions.md        [D7k2qf] 결정 한 줄씩 · ★ 고정 · ~~대체됨~~
├── index.md            자동 생성 타임라인 (하루/한 달당 한 줄)
├── journal/2026-11/2026-11-06.md
├── digests/2026-09.md
├── archive/2026-09/…   롤업된 원본 (읽기·검색 가능)
├── config.json
└── .local/             이 머신의 세션 상태 (gitignore)
```

**커밋하세요.** 팀원, 다른 머신, 다른 에이전트가 같은 기억을 공유합니다.
순수 Markdown과 `[[wikilink]]`라서 `.ad/`를 그대로 Obsidian vault로 열면 프로젝트 역사가 위키처럼 쌓여 있습니다.

여러 사람과 브랜치가 동시에 기록해도 git에서 문제가 없도록 만들었습니다.

- `.ad/.gitattributes`가 덧붙이기만 하는 파일(일별 일기, `decisions.md`)을 git의 `union` 방식으로 병합합니다. 두 브랜치가 같은 날 기록해도 충돌이 나지 않습니다.
- 결정 번호는 내용 기반의 짧은 해시라서 브랜치끼리 겹치지 않습니다. 병합 후 같은 결정이 두 버전으로 남으면 읽을 때 합칩니다. 대체됨이 우선하고 고정은 유지됩니다.
- 자동 생성되는 `index.md`와 이 머신 전용 `.local/`은 커밋하지 않습니다. 예전 설정으로 `index.md`를 커밋했다면 `ad doctor`가 알려 줍니다.
- API 키, 토큰, 개인 키, 비밀번호가 들어간 URL처럼 보이는 내용은 쓰기가 거부되고, 그 값은 메시지에 다시 나오지 않습니다.

## 사용

아무것도 안 해도 됩니다. 직접 다루고 싶을 때는 아래를 씁니다.

- **pi 명령**: `/diary`(상태), `/diary init`, `/diary write [메모]`, `/diary compact`, `/diary recall`(이번에 떠올린 기억), `/diary show`, `/diary reload`
- **에이전트 도구 (pi)**: `diary_write`, `diary_update`, `diary_read`, `diary_search`
- **CLI**:

```bash
ad stats                      # 세션 비용, 롤업 대상
ad doctor                     # 상태 점검
ad search 빌드 왜 vite        # 전체 기록 관련도 검색
ad read 2026-10-12            # 하루 · 2026-10 한 달 · Dq3m8a 결정과 그 출처 일기
ad compact run --summarizer "claude -p --model haiku"
```

## 설정

`.ad/config.json`의 모든 항목은 [README.md#configuration](README.md#configuration)에 있습니다. 자주 바꾸는 항목은 다음과 같습니다.

- `nudgeAfterMutations`: 몇 번 수정하면 기록을 요청할지 (기본 6)
- `recall.minScore`: 떠오르는 기억이 너무 많으면 올리기
- `compactModel`(pi) / `summarizer`(CLI): 롤업에 쓸 저렴한 모델
- `autoWrite`, `autoCompact`: `auto` | `remind` | `off`

`AGENT_DIARY_AUTO_INIT=0`으로 `.ad/` 자동 생성을 끌 수 있습니다. git 저장소 밖에서는 자동으로 만들지 않습니다.

## 설계

왜 extension + skill + library 조합인지, 각 부분이 컨텍스트를 어떻게 묶어 두는지는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.
