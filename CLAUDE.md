# pnu_api_mcp

주소·PNU로 건물과 필지의 관계를 판정하는 MCP 서버와 웹. 설계는 `docs/design.md`.

## 세션을 시작하면

1. `docs/design.md` §7 작업 순서에서 `← 다음 작업` 표시를 찾는다. 끝낸 항목은 `[x]`로 바꾸고 다음 항목으로 표시를 옮긴다.
2. §3의 **「아직 확인 안 된 것」** 목록을 본다. 구현하면서 실제 응답으로 확인한 것은 「확인된 사실」로 옮긴다. 기억으로 채우지 않는다.
3. `.env`에 어떤 키가 있는지 **값을 출력하지 말고** 이름만 확인한다(`DATA_GO_KR_KEY`가 비어 있으면 사용자에게 묻는다).

## 개발 환경 메모 (Windows)

- pnpm은 corepack으로 사용자 npm 폴더(`npm prefix -g`)에 설치돼 있다. `pnpm`을 못 찾으면 PowerShell에서 `$env:Path="$(npm prefix -g);$env:Path"`.
- pnpm의 `minimumReleaseAge` 정책이 공개 하루 미만 패키지를 막는다. 막히면 **예외를 추가하지 말고** 한 단계 이전 버전으로 고정한다.
- 검증 한 번에: `pnpm lint; pnpm turbo run typecheck test build`. 포맷 자동 수정은 `pnpm exec biome check --write .` (`.github/ISSUE_TEMPLATE`은 포맷 대상에서 뺐다 — 머리말이 깨진다).
- 공공 API 실제 응답을 fixture로 저장할 때 요청 URL·응답에 들어간 키(`confmKey`, `serviceKey`, `key`)는 반드시 지운다. 공개 레포다.

## 구조

```
packages/core   PNU·법정동·대장 키·주소 검색(juso)·대장 조회(건축HUB)·공간 조회(VWorld + Turf), 관계 분류 — 로직은 전부 여기
packages/mcp    MCP 서버 (stdio). core만 호출
apps/web        (예정) Next.js. core만 호출
```

## 하네스

- 패키지 매니저 pnpm(workspace), 태스크 러너 Turborepo, 린트·포맷 Biome, 테스트 Vitest, TypeScript strict.
- 빌드·테스트는 루트에서 `pnpm turbo run <task>`로 한다. 패키지 디렉터리에서 따로 빌드하지 않는다(캐시 불일치).
- 무엇을 다시 빌드할지는 Turborepo 해시에 맡긴다. 골라서 빌드하지 않는다.
- 패키지 간 import는 workspace 패키지명(`@pnu/core`)으로. 상대경로로 다른 패키지를 넘지 않는다.
- 빌드에 영향을 주는 환경변수는 `turbo.json`의 `env`에 등록한다.
- 커밋 전: `pnpm lint` + `pnpm turbo run typecheck test build`.
- LLM 계층 없음(MCP 서버는 도구만 제공하고 추론은 클라이언트가 한다).

## 규칙

- **공개 레포다. API 키(`JUSO_KEY`, `DATA_GO_KR_KEY`, `VWORLD_KEY`)는 절대 커밋하지 않는다.** 로컬은 `.env`, CI·배포는 GitHub Secrets·AWS 비밀 저장소.
- 공공 API 엔드포인트·파라미터는 기억으로 쓰지 않는다. 포털 명세나 실제 응답으로 확인하고, 확인한 응답은 `packages/core/fixtures/`에 넣어 테스트로 묶는다.
- 필지구분 값 체계가 소스마다 다르다: PNU `1/2`, 건축물대장 `platGbCd` `0/1`. 변환은 `pnu.ts`의 함수만 쓴다.
- 확인하지 않은 값 체계는 해석하지 않고 원값을 돌려준다(예: 건물관리번호의 산 여부 자리).
- 테스트·예시에 개인 주소를 쓰지 않는다. 공공건물이나 블로그에 공개한 예시(상봉동 126-39)를 쓴다.
