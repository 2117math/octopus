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
3. 패치 1(2026-10-23 원장 2차 개정): `src/account-manager.js` `_pickLeastLoadedEven`(새 세션·failover 배정). 원장 요구 — 「한 계정에 두 개까지, 어쩔 수 없지 않다면 분리」 · 「주간 40/60/87% 구간」 · 「87%는 놔뒀다가 마지막에 5시간 한 번으로 마무리」 · 한 번 배정된 세션은 그 계정의 5시간 사용량이 다 찰 때까지 바꾸지 않는다. 1차(주간 사용률 2%p 칸이 세션 수보다 앞)는 가장 낮은 계정에 새 세션 4개가 전부 몰려 폐기. 정렬 키(앞 키가 같을 때만 다음 키): priority → heldOff(`_belowBandFloor`) → **reserve**(`_reserveRank`: governing weekly 창이 24시간 안에 리셋되고 사용률 98% 미만이면 0 — 리셋 전 마무리라 87% 이상이어도 먼저 쓴다 · 사용률 87% 이상이고 리셋이 24시간 밖이면 2 — 아껴 둠 · 그 밖 1) → **hot5h**(`_hot5hRank`: 5시간 사용률이 알려져 있고 80% 이상이면 1) → **full**(붙어 있는 세션이 2개 이상이면 1) → **tier**(`_tierRank`: 주간 40% 미만 0 · 60% 미만 1 · 그 밖 2 · 모름 0) → 세션 수(`knownCountFor` — 쉬는 중이지만 붙어 있는 세션 포함·클라이언트 세션 단위; `activeCountFor` 는 2분 안에 움직인 세션만 세므로 쓰지 않음) → 주간 사용률(양자화 없음, 모름이 맨 앞) → inFlight → pressure → reset. 모든 계정이 가득(2개 이상)이면 full 이 같아져 tier 낮은 쪽부터 3개째가 붙는다. 세션 고정: `_selectForSession` 은 pin 계정이 `_isAvailable` 인 동안 그대로 두고(해제 조건 = 5h/주간이 switchThreshold 이상·rate limit·disabled·upstream rejected·priority 더 높은 계정 등장·expiry preempt 켠 경우 리셋 롤오버), `_rebalanceIdle` 은 pin 계정의 5시간 사용률이 알려져 있고 1 미만이면 설정을 켜 둬도 옮기지 않는다. pin 은 메모리(`SessionTracker`)에만 있어 서버를 재시작하면 열린 세션이 새 규칙대로 다시 배정된다.
4. 패치 2: `src/warmer.js` `resolveClaudeCommand()` — Windows에서 `@anthropic-ai/claude-code/bin/claude.exe`가 형제 폴더에 있으면 그 경로로 워밍업 실행.
5. 색 규칙: `src/tui.js` `barColor`는 채움률만으로 색을 정한다(0-49 초록, 50-74 노랑, 75-89 주황, 90+ 빨강, 임계값 이상은 항상 빨강).
6. 테스트: 위 변경에 맞춰 기대값을 고쳤다(profile-tier 는 구독 필드 3개 추가, tui-bar, terminal-title, updater skip, expiry-pressure/adaptive-distribution은 패치 1 항(주간 사용률·reserve·tier)을 고정값으로 중립화, session-affinity 는 새 순서로 기대값 수정, 새 테스트 `test/weekly-balance.test.js`).
8. move 화면(`src/tui.js` `_renderMove`, 원장 2026-10-23 「그거 보면서 옮기는 것」): 계정 줄마다 `5h 24% · 주 91%`(모르면 `—`, 주간 리셋이 24시간 안이면 `· 리셋 18h` 꼬리, 5h 80%↑·주 90%↑ 는 막대와 같은 주황/빨강). 대시보드 HTTP `/teamclaude/session-move` 는 계정 고르기 화면이 없는 API 라 해당 없음(attach 모드 TUI 는 같은 화면).
9. 구독 갱신일 표시(2026-10-24 원장 「해당 계정이 무슨 날짜에 한 달 계정이 마무리되는지」): OAuth 프로필 `organization.subscription_created_at`·`subscription_status`·`billing_type` 을 `normalizeProfile`→`applyProfileData` 로 계정에 저장하고 `exportQuotaState` 의 profile 로 상태 파일에 남긴다(Codex·프로필 미수신 계정은 없음 = 표시 없음). 순수 함수 `src/subscription.js` `nextRenewal`(매달 같은 날·같은 시각의 UTC 순간, 그 달에 그날이 없으면 말일, 지금 이후 가장 가까운 것) · `subscriptionText`(`구독 M/D D-n`, KST 달력 기준, 당일 `D-day`, 상태가 active 가 아니면 `구독 상태: …`). 표시: TUI 계정 줄 맨 끝(줄이 모자라면 먼저 잘림)·move 화면 계정 줄·`/teamclaude/status` 계정의 `subscription:{createdAt,status,renewAt(ms),daysLeft}`·대시보드 계정 카드 한 줄. D-3 이하 주황, D-day·비활성 상태 빨강. 갱신은 프로브(`quotaProbeSeconds`, 기본 꺼짐)와 무관한 `src/subscription-refresher.js`가 맡는다 — 서버 시작 5초 뒤 1회 + 6시간마다 anthropic OAuth 계정(disabled·Codex 제외)마다 `fetchProfile`(동시 2개·10초 타임아웃·401이면 토큰 강제 갱신 후 1회 재시도·실패는 로그 한 줄), `src/index.js`가 시작·종료 때 켜고 끈다. 테스트 `test/renew-date.test.js`.
10. Host 줄 정리 키(2026-10-24 원장 「바탕화면 말고 Octopus 화면 안에 버튼」): Host 줄 끝에 `· [x] 정리`(대상이 있으면 주황 `· [x] 정리 3개 0.4GB`, 자리가 모자라면 안내만 먼저 빠짐)가 붙고 `x` 키가 정리 창을 연다(`y` 모두 끄기 · `Esc` 닫기). Windows 의 이 PC 에서만 — attach 모드(Host 줄이 서버 PC 것)·그 밖 OS 는 키·안내 모두 숨김. 판정은 순수 함수 `src/cleanup.js` `classifyLeftovers(list, now, selfPids)`(규칙 원본 `C:\Claude\tools\cleanup_leftovers.ps1`): ①`--headless` 가 있고 `--type=` 없는 msedge/chrome 본체(딸린 `--headless` 프로세스까지 끄고 메모리 합산) ②부모가 없고 10분 넘은 find/grep/rg ③30분 넘은 python `http.server` ④30분 넘은 node `verify_*.js`·`--test`. 절대 안 끔: Octopus 자신과 그 부모·이름이 claude 인 것·명령줄에 octopus 가 있는 것·`--headless` 없는 브라우저. 프로세스 목록은 PowerShell 비동기(타임아웃 10초), 대상 수는 1분마다(첫 조회 5초 뒤·`hostLine` 꺼짐이면 생략), `x` 를 누르면 그 자리에서 새로 조회, `y` 를 누르면 끄기 직전에 한 번 더 조회해 pid 와 시작 시각이 같은 것만 끈다(pid 재사용 방지). 결과는 활동 로그에 `5개 껐습니다 · 메모리 0.9GB 확보`. 기존 시험 `test/tui-login-panel.test.js` 의 「ESC 뒤 아무 키」 시험이 우연히 `x` 를 써서 `z` 로 바꿨다. 테스트 `test/cleanup.test.js`.
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
