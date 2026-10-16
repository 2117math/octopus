# Octopus (TeamClaude v1.1.25 포크)

## 정체
- 원본: KarpelesLab/teamclaude (MIT). Claude Code/Codex 다계정 프록시. 이 저장소는 v1.1.25 위에 만든 로컬 포크 "Octopus 1.0.0".
- npm에 올리지 않는다. 설치는 이 폴더에서 `npm link`(또는 `node src/index.js`).
- 브랜치 `octopus`, 원본 리모트는 `upstream`.

## 실행·테스트
- 서버: `octopus server` (헤드리스는 `--headless`), Claude 실행: `octopus run`
- 테스트: `node --test` (의존성 설치 불필요). Windows에서 원본에서도 실패하는 테스트가 있다(아래 참고).
- 문법 확인: `node --check src/<파일>.js`

## 원본과 다른 점
1. 이름: package.json(name/bin/version 1.0.0), 로그 머리말 `[Octopus]`, TUI·대시보드 제목, CLI 사용법·도움말·README·docs의 보이는 문자열. README 맨 위에 포크 표기.
2. 업데이터 무력화: `src/updater.js`의 `checkForUpdate()`와 `autoUpdate()`는 맨 앞에서 return. `octopus update`는 안내 한 줄만 출력. 관련 테스트 7개는 skip.
3. 패치 1: `src/account-manager.js` `_pickLeastLoadedEven`에 "주간 사용률 낮은 계정 먼저" 항(`_rankedWeeklyUsed`)을 priority·heldOff 다음, sessions 앞에 추가.
4. 패치 2: `src/warmer.js` `resolveClaudeCommand()` — Windows에서 `@anthropic-ai/claude-code/bin/claude.exe`가 형제 폴더에 있으면 그 경로로 워밍업 실행.
5. 색 규칙: `src/tui.js` `barColor`는 채움률만으로 색을 정한다(0-49 초록, 50-74 노랑, 75-89 주황, 90+ 빨강, 임계값 이상은 항상 빨강).
6. 테스트: 위 변경에 맞춰 기대값을 고쳤다(tui-bar, terminal-title, updater skip, expiry-pressure/adaptive-distribution은 패치 1 항을 0으로 고정).
7. 별칭: `octopus alias`는 `octopus`를 가리키고, 쉘 rc 표식 `# teamclaude alias`는 그대로다.

## 이름을 바꾸지 않은 것 (호환성)
- 설정·상태·인증서 파일명(`teamclaude.json`, `teamclaude.state.json`, `teamclaude-ca.pem` 등)은 그대로. 이미 설치된 TeamClaude와 같은 설정·계정·CA를 공유하려는 것이다.
- 환경변수 `TEAMCLAUDE_*`, HTTP 경로 `/teamclaude/…`, `/tc-acct/…`, `x-teamclaude-*` 헤더, MCP 서버·도구 이름, 인증서 CN, systemd/launchd 이름, 내부 식별자.
- Dockerfile, nix/, flake.*, .github/ 는 손대지 않았다.

## 원본 합치기
1. `git fetch upstream --tags`
2. `git merge <새 태그>` (예: v1.1.26)
3. 충돌은 위 "다른 점" 1~5 기준으로 푼다. 새로 생긴 `[TeamClaude]` 로그·사용법 문자열은 `Octopus`로 바꾸되 위 "바꾸지 않은 것"은 건드리지 않는다.
4. `node --test`로 확인. 원본에서도 실패하는 항목과 비교한다.

## 알려진 사항
- 원본(Windows)에서도 실패하는 테스트 19개: service, alias 경로, crash-log, 활동 로그 0600, MITM h2 취소 등 POSIX 전제 테스트.
