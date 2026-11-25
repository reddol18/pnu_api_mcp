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
packages/mcp    MCP 서버 (stdio). core만 호출. 도구 5개, 응답 모양은 core의 present.ts. 루트 .mcp.json이 .env를 읽어 띄운다
apps/web        Next.js 16. core만 호출(/api/analyze). 로컬 실행: pnpm --filter @pnu/web dev (루트 .env를 읽는다)
infra           AWS 배포: template.yaml(CloudFormation), deploy.mjs, run.sh. zip은 GitHub Actions build-lambda가 만든다
```

## 배포 (AWS, 계정 루트로 aws login)

- AWS CLI는 `F:\aws_cli\aws.exe`(PATH에 없음). `aws login`으로 로그인, 리전 `ap-northeast-2`.
- 순서: main에 push → `build-lambda` 성공 → `gh run download <id> -n pnu-web-lambda -D <폴더>` → `$env:AWS_CLI='F:\aws_cli\aws.exe'; $env:BUDGET_EMAIL='…'; node infra/deploy.mjs <zip>`.
- AWS 리소스를 만들거나 바꾸는 명령은 실행 전에 무엇을 만드는지·비용을 사용자에게 보여 주고 확인받는다.
- 파라미터 바꾸기: `--param MemorySize=512`, `--param ReservedConcurrency=100`, `--param KillSwitchGbSeconds=10000`. 주지 않으면 스택의 기존 값을 쓴다.
- **차단 스위치가 내렸을 때(메일 "pnu-web-usage-kill-switch" ALARM):** 웹 함수의 예약 동시 실행이 0이라 모든 요청이 거절된다. 원인(로그·급증)을 먼저 보고, 되살리기는 `F:\aws_cli\aws.exe lambda put-function-concurrency --function-name pnu-web --reserved-concurrent-executions 100 --region ap-northeast-2` 또는 다시 배포(템플릿 값으로 돌아간다). 경보가 아직 ALARM이면 다음 5분 지표에서 다시 내려가지 않게 원인부터 막는다.

## 요청 통계 (CloudWatch Logs Insights, 로그 그룹 `/aws/lambda/pnu-web`, 7일 보관)

웹 Lambda가 요청마다 `{"log":"access","m","p","s","ms","ip","ua"}` 한 줄을 남긴다(`infra/access-log.cjs`, 쿼리 문자열은 남기지 않는다). CloudFront 캐시에서 끝난 요청(정적 파일·타일)은 Lambda에 오지 않아 여기 없다.

- 경로·응답 코드별: `filter log="access" | stats count(*) as n, avg(ms) as avgMs by p, s | sort n desc | limit 30`
- IP별(스캐너 찾기): `filter log="access" | stats count(*) as n, sum(s>=400) as err by ip | sort n desc | limit 20`
- 시간대별: `filter log="access" | stats count(*) as n by bin(1h)`
- IP·UA는 개인정보로 다룬다. 저장소·이슈에 그대로 옮기지 않는다.

## 의심 접속 차단 (이슈 #8)

- **문지기 CloudFront Function `pnu-web-guard`**(`apps/web/cloudfront/guard.js`)가 기본 동작(페이지·API) 앞에서 `/`·`/api/analyze`와 GET·HEAD만 통과시키고 나머지는 Lambda 호출 없이 404·405로 끝낸다. **페이지·API 경로를 새로 만들면 `ALLOWED`에 넣는다.**
- **차단 갱신 Lambda `pnu-web-guard`**(`apps/web/cloudfront/guard-updater.cjs`, 10분마다)가 요청 로그에서 기준을 넘은 IP를 문지기 함수의 `BLOCKED` 줄에 넣어 다시 게시한다(403, `GuardBlockHours` 뒤 자동 해제). 결과는 `/aws/lambda/pnu-web-guard` 로그의 `{"guard":"checked|dry-run|published",...}`.
- 기준값(`GuardMaxRequests`·`GuardMaxErrors`)은 저장소에 적지 않고 배포 때 `--param`으로만 준다(스택에 남는다). 처음엔 `GuardDryRun=true`(기록만), 걸리는 것을 보고 `--param GuardDryRun=false`.
- **잘못 막혔을 때:** `aws cloudfront get-function --name pnu-web-guard --stage DEVELOPMENT <파일>`로 받아 `var BLOCKED = {...};` 줄에서 그 IP를 빼고, `describe-function`의 ETag로 `update-function --if-match <ETag> --function-config Comment=…,Runtime=cloudfront-js-2.0 --function-code fileb://<파일>` → 새 ETag로 `publish-function`. 기준값이 너무 낮으면 다음 갱신에 다시 걸리니 `--param`으로 기준값부터 올린다.
- guard.js를 고쳐 배포하면 차단 목록이 비고 다음 갱신에서 다시 채워진다.

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
