# pnu_api_mcp 설계 문서 (v0.2, 2026-11-25)

> v0.1(필지 종합 조회: 지목·공시지가·용도지역)은 2단계로 내렸다. 1단계는 **필지-건물 관계 판정**이다.

## 1. 목적

주소나 PNU를 넣으면 **건물과 필지의 관계**를 알려 주는 도구. Claude에서 바로 쓰는 **MCP 서버**와 웹 조회 화면을 함께 만든다.

- 건물 하나가 여러 필지에 걸친 경우(건물 → 필지 N)
- 필지 하나에 건물이 여러 동인 경우(필지 → 건물 N)
- 이 둘을 대장(법적 관계)과 공간(실제 겹침) 두 근거로 판정하고, 서로 다르면 그것도 알려 준다

### 왜 하는가

- **블로그 검색:** 유입 1위 글이 `/make-pnu-code`(최근 28일 노출 107, 클릭 7). 이 글을 읽은 개발자가 다음에 부딪히는 문제가 "PNU로 조회했는데 건물이 안 맞는다"이다. 공공 API는 필지 기준인데 관리 대상은 건물이라서 생긴다. 이 주제를 다룬 공개 도구나 글이 드물다.
- **건물관리 실무와의 접점:** 건물 단위로 공공 데이터(대장·점검·에너지)를 모으려면 이 관계부터 풀어야 한다.
- **기술 실험:** MCP 서버(Claude 연동) + Next.js/TypeScript + PostgreSQL + AWS Lambda.

### 성공 기준

- 지번주소, 도로명주소, 19자리 PNU 세 가지 입력을 모두 받는다. 산 번지 포함.
- 결과를 `1:1`, `1:N`, `N:1`, `N:M`으로 분류하고, 대장·공간 근거를 따로 보여 준다.
- Claude Code에서 MCP로 "이 주소 건물이 필지 몇 개에 걸쳐 있어?"에 답한다.
- 블로그 글 2편 이상: ① 건물과 필지가 1:1이 아닐 때 ② MCP 서버로 만들기.

### 범위 밖 (1단계)

- 공시지가·용도지역 등 땅 정보 조회(2단계), 법정 점검 일정, 에너지 데이터, 회원·저장 기능.

---

## 2. 핵심 개념

### 2-1. 주소 종류가 출발점을 정한다

| 입력        | 가리키는 것 | 출발점        |
| ----------- | ----------- | ------------- |
| 도로명주소  | **건물**    | 건물 → 필지들 |
| 지번주소    | **필지**    | 필지 → 건물들 |
| PNU(19자리) | **필지**    | 필지 → 건물들 |

도로명주소 검색 API는 건물관리번호(25자리)를 함께 준다. 구조는 `법정동코드 10 + 산 여부 1 + 본번 4 + 부번 4 + 일련 6`으로 PNU와 닮았지만 **앞 19자리를 PNU로 쓰면 안 된다**(발급 당시 값이라 옛 법정동코드·옛 부번이 남아 있다, §3 확인된 사실). PNU는 검색 결과의 `admCd + mtYn + lnbrMnnm + lnbrSlno`로 만든다.

### 2-2. PNU 규칙

```
법정동코드 10 (시도2 + 시군구3 + 읍면동3 + 리2) + 필지구분 1 (1=일반, 2=산) + 본번 4 + 부번 4 = 19자리
```

**건축물대장 API는 필지구분 값이 다르다:** PNU 1 → `platGbCd=0`(대지), PNU 2 → `platGbCd=1`(산). 변환 함수는 하나로 고정하고 테스트로 묶는다.

### 2-3. 관계를 판정하는 두 근거

| 근거                 | 건물 → 필지들                         | 필지 → 건물들                                    |
| -------------------- | ------------------------------------- | ------------------------------------------------ |
| **대장 기준** (법적) | 표제부의 대표지번 + **부속지번** 목록 | 그 지번으로 조회되는 표제부(동) 목록, 총괄표제부 |
| **공간 기준** (실제) | 건물 외곽선이 걸친 필지들과 겹침 비율 | 필지 경계 안에 들어오는 건물 외곽선들            |

- 공간 데이터: VWorld 연속지적도 `LP_PA_CBND_BUBUN`(필지 경계, PNU 속성) + 도로명주소 건물 `LT_C_SPBD`(건물 외곽선, 건물관리번호 속성).
- 겹침 비율이 아주 작은 것(예: 1% 미만)은 측량 오차로 보고 "경계 접촉"으로 따로 표시한다. 기준값은 실제 데이터로 정한다(§3 미확인 목록 — 아직 못 정함).
- **불일치 표시:** 예) 대장에는 부속지번이 없는데 공간상으로는 두 필지에 걸침 / 대장상 같은 지번의 동인데 외곽선이 다른 필지에 있음.
- **확인됨:** 건축HUB에는 "이 필지를 부속지번으로 쓰는 건물"을 거꾸로 찾는 요청 변수가 없다. 그래서 필지 → 건물 방향은 공간 기준으로 채우고 그 사실을 결과에 적는다.

### 2-4. 알려진 함정 (블로그 글감)

- 건물과 필지는 1:1이 아니다 → 건물관리 시스템의 키는 PNU 하나로 부족하다(건축물대장 PK 또는 건물관리번호 + PNU).
- 합필·분필, 행정구역 변경으로 PNU가 바뀐다 → 결과에 데이터 기준일을 붙인다.
- 집합건물은 표제부(동) 아래 전유부(호)가 있다 → 1단계는 동 단위까지만.

---

## 3. 데이터 소스

> 엔드포인트·파라미터 이름은 구현 착수 시 각 포털 명세로 재확인한다.

| 용도                                | 소스                                        | 입력                                   |
| ----------------------------------- | ------------------------------------------- | -------------------------------------- |
| 주소 → 법정동코드·지번·건물관리번호 | 행정안전부 도로명주소 검색 API (juso.go.kr) | 자유 입력 주소                         |
| 법정동코드 표 (오프라인)            | 공공데이터포털 법정동코드 파일              | — (해독기, 저장소에 스냅숏 + 기준일)   |
| 표제부·총괄표제부                   | 국토교통부 건축HUB 건축물대장정보           | sigunguCd, bjdongCd, platGbCd, bun, ji |
| 부속지번                            | 건축물대장정보의 부속지번 조회              | 같은 키                                |
| 필지 경계                           | VWorld 데이터 API 연속지적도                | PNU                                    |
| 건물 외곽선                         | VWorld 데이터 API GIS 건물통합정보          | 공간 조회(필지 경계와 겹치는 것)       |

인증키: juso 승인키, 공공데이터포털 키, VWorld 키 → `.env`와 AWS 비밀 저장소로만 관리.

**확인된 사실 (2026-11-25, 웹 페이지 조회로 확인):**

- 건축물대장은 **국토교통부_건축HUB_건축물대장정보 서비스** https://www.data.go.kr/data/15134735/openapi.do — 호출 주소 `https://apis.data.go.kr/1613000/BldRgstHubService`. 오퍼레이션 목록에 **"건축HUB_건축물대장 부속지번 조회"**가 있다(영문 오퍼레이션명은 미확인 — 명세 문서에서 확인).
- 예전 「국토교통부_건축물대장정보 서비스」(15044713)는 페이지가 없어졌다(404). 건축HUB로 옮기면서 **건축데이터 PK가 바뀌었다**는 안내가 있다 → 인터넷의 옛 예제 코드(엔드포인트·PK)를 그대로 쓰지 않는다.
- 도로명주소 개발자센터는 개편되어 옛 주소(`/addrlink/openApi/...`)가 404다. 현재: API 목록 `https://business.juso.go.kr/jst/jstAddressApiList`, 검색 API 안내 `https://business.juso.go.kr/jst/jstRoadNmAddrApiSearch`. 승인키는 **API마다 따로** 나온다(좌표제공 API를 쓰면 키 추가).
- 브이월드 인증키 화면의 「활용API」 선택지(캡처로 확인): 2D 지도, 3D 지도, 배경지도, WMS/WFS, WMTS/TMS, 2D데이터, 지오코더, 검색, 이미지, 범례, 2D 모바일, 3D 모바일, 3D데스크톱, 국가중점. 이 프로젝트는 **2D데이터 API**(연속지적도·건물통합정보)가 핵심.

**확인된 사실 — juso 검색 API (2026-11-25, 명세 페이지 JS 번들 + 실제 응답, `packages/core/fixtures/juso/`):**

- 요청: `POST https://business.juso.go.kr/addrlink/addrLinkApi.do` (form). `confmKey`, `currentPage`, `countPerPage`, `keyword`, `resultType=json`, `addInfoYn=Y`(→ `relJibun`·`hstryYn`·`hemdNm` 추가). 안내 페이지는 SPA라 일반 fetch로는 본문이 안 보인다 — 명세는 `/assets/jstRoadNmAddrApiSearch-*.js`에 있다.
- 응답 `results.common`: `totalCount`, `currentPage`(명세엔 `currentPerPage`로 오기), `countPerPage`, `errorCode`(정상 `"0"`), `errorMessage`. 오류일 때 `juso`는 `null`, 결과 0건이면 `[]`. HTTP는 오류여도 200.
- 숫자 필드(`lnbrMnnm`, `buldMnnm` 등)도 **모두 문자열**. 명세에 없는 `emdNo`도 온다.
- `admCd` = **현행** 법정동코드 10자리. `mtYn` = `0` 대지 / `1` 산(YTN서울타워 산1-3으로 확인).
- **건물관리번호 앞 19자리 ≠ PNU.** YTN서울타워: 지번 산1-3인데 `bdMgtSn` 부번은 `0011`. 낭성면 행정복지센터: `admCd` `4311131025`(청주시)인데 `bdMgtSn` 앞 10자리 `4371031026`(옛 청원군). 11번째 자리는 `0`·`1`(서울 대지)·`2`(산)가 모두 나온다 → 해석하지 않는다.
- `relJibun`(관련지번)이 채워져 오는 건물이 있다(낭성면 행정복지센터: 이목리 120-4). 건물 → 필지 판정의 보조 근거로 쓸 수 있다. 여러 개일 때 구분 형식은 미확인.
- 한 필지에 도로명주소 건물이 여럿인 실제 사례: 용산동2가 산1-3 (남산공원길 105, 126). 블로그 예시 상봉동 126-39는 도로명주소 건물이 0건.
- 오류코드 E0008(두 글자 미만), E0013(SQL 예약어·`%=<>[]`) 실제로 확인.
- **지번 검색은 건물 단위다.** 그 지번을 대표지번으로 하는 도로명주소 건물이 있어야 나온다. 그래서 도로(태평로1가 31-1), 없어진 지번(상봉동 126-39), 빈 땅처럼 건물이 대표지번으로 걸려 있지 않은 필지는 0건이다. 또 **관련지번(`relJibun`)으로도 찾아 준다**: "이목리 120-4" → 대표지번 120-3인 낭성면 행정복지센터. → 지번주소 → PNU는 juso에만 기대지 않고 법정동코드 표로 직접 만든다(§4-1).

**확인된 사실 — 건축HUB 건축물대장 (2026-11-25, 포털 페이지의 swagger + 실제 응답, `packages/core/fixtures/ledger/`):**

- `GET https://apis.data.go.kr/1613000/BldRgstHubService/{op}` — 표제부 `getBrTitleInfo`, 총괄표제부 `getBrRecapTitleInfo`, 부속지번 `getBrAtchJibunInfo`. 요청 변수는 셋 다 같다: `serviceKey`, `sigunguCd`, `bjdongCd`, `platGbCd`(0 대지·1 산·**2 블록**), `bun`, `ji`, `startDate`, `endDate`, `_type`, `numOfRows`, `pageNo`. swagger는 `data.go.kr/data/15134735/openapi.do` 페이지 HTML의 `swaggerJson` 변수에 들어 있다.
- `.env`의 키는 인코딩 키(`%` 포함) → 한 번 풀어서 보낸다(이중 인코딩 방지).
- PK 필드는 `mgmBldrgstPk`(관리건축물대장PK) — **JSON 숫자**로 온다(최대 15자리 확인). 정밀도 보호를 위해 파싱 전에 문자열로 바꾼다. `totArea`·`bylotCnt`·`mainBldCnt`도 숫자, 나머지는 문자열. 빈 값은 `" "`(공백 한 칸). `totalCount`는 숫자로도 문자열로도 온다.
- 정상 `response.header.resultCode` `"00"`. 0건이면 `items.item = []`.
- 게이트웨이 오류는 모양이 다르다: `OpenAPI_ServiceResponse.cmmMsgHeader.returnReasonCode`. **`05` SERVICETIMEOUT_ERROR(HTTP 503)가 간헐적으로 온다**, 등록 안 된 키는 `30`(HTTP 403). 보통 100ms 안팎인 응답이 5초 넘게 멈추는 경우도 봤다 → 503·05·타임아웃은 재시도.
- `regstrGbCd` 1 일반 / 2 집합, `regstrKindCd` 1 총괄표제부 / 2 일반건축물 / 3 표제부(집합의 동), `mainAtchGbCd` 0 주건축물 / 1 부속건축물, `bylotCnt` 외필지수.
- `bun`만 주고 `ji`를 빼면 그 본번의 모든 부번이 나온다(와일드카드).
- **부속지번 역방향 조회는 불가:** 요청 변수에 부속지번 필드가 없다 → 필지 → 건물 방향은 공간 기준으로 채운다(§2-3).
- 실제 사례:
  - 서울시청(태평로1가 31): 표제부 2, 한 대장에 부속지번 31-1 → **건물 → 필지 N**.
  - 남산 산1-3: 표제부 3(주 1 + 부속 2), 부속지번 모두 산1-11. juso 건물관리번호의 부번 `0011`이 이 부속지번이었다.
  - 낭성면 행정복지센터(이목리 120-3): 총괄표제부(주건축물 3, 외필지 2, 부속지번 34-6·262-3)는 있는데 **같은 지번의 표제부는 0건** → 대장 안에서도 총괄과 표제부를 지번으로 못 잇는 경우가 있다. juso `relJibun`(120-4)은 대장 부속지번과 다르다.
  - 정원팰리스(상봉동 126-52): 집합 총괄표제부 1 + 표제부 3동.
  - 블로그 예시 상봉동 126-39: 표제부 0건.

**확인된 사실 — VWorld 2D데이터 API 2.0 (2026-11-25, 레퍼런스 페이지 + 실제 응답, `packages/core/fixtures/spatial/`):**

- `GET https://api.vworld.kr/req/data` — `service=data`, `version=2.0`, `request=GetFeature`, `format=json`, `key`, `domain`, `data`(레이어), `size`(최대 1000), `page`, `attrFilter`(`속성:연산자:값`) 또는 `geomFilter`(POINT·LINESTRING·POLYGON·MULTIPOLYGON·BOX, 면적 2km² 이하), `crs`(기본 EPSG:4326). 레퍼런스: `vworld.kr/dev/v4dv_2ddataguide2_s002.do?svcIde=<id>`(POST `apiVer=2`).
- **서버 호출에는 `domain`이 반드시 필요하다.** 빼거나 키에 등록하지 않은 URL(예: example.com)이면 `INCORRECT_KEY`. 등록한 `https://pnu.reddol18.pe.kr`과 `http://localhost` 둘 다 동작 → `.env`의 `VWORLD_DOMAIN`.
- 필지 경계: **`LP_PA_CBND_BUBUN`**(연속지적도). `attrFilter=pnu:=:<PNU>`로 바로 조회. 속성 `pnu`, `addr`, `jibun`(`31대`처럼 지목 글자 포함), `bonbun`·`bubun`(`1도`·`3임`처럼 지목 글자가 섞여 나와 쓰지 않는다), `jiga`, `gosi_year`, `gosi_month`. 도형은 MultiPolygon.
- 건물 외곽선: **`LT_C_SPBD`**(도로명주소 건물, 행정안전부). `attrFilter=bd_mgt_sn:=:<건물관리번호>`로 바로 조회 → juso 결과와 바로 이어진다. 속성 `bd_mgt_sn`, `buld_nm`, `buld_nm_dc`(동), `rd_nm`, `buld_no`, `gro_flo_co`. 레퍼런스에도 건물관리번호가 "생성 당시 기준의 PNU + 연번이고 행정구역이 바뀌어도 반영 안 됨"이라고 적혀 있다.
- `LT_C_BLDGINFO`(건축물정보, 국토교통부)는 식별자 속성이 없고(pnu 필터 불가, 속성은 `bld_nm`·`dong_nm`·면적 등) 값 대부분이 비어 있다 → 1단계에서는 쓰지 않는다. 도로명주소가 없는 부속건축물은 `LT_C_SPBD`에 없다는 한계가 있다.
- 응답 `response.status`: `OK` / `NOT_FOUND`(결과 없음, `result` 없음) / `ERROR`(`error.code`). 숫자도 문자열.
- **BOX 필터는 사각 범위에 닿는 것을 모두 준다**(서울시청 근처 지하상가 하나로 필지 121개). 그래서 외곽선 그대로 POLYGON/MULTIPOLYGON 필터를 건다(URL 1~4KB, 산 필지 3.5KB). 너무 길면 BOX로 받고 Turf로 거른다.
- 응답 시간 보통 100~500ms.
- 실제 사례(공간 기준):
  - 서울시청 본관동·신관: 100% 31번지 안. 대장 부속지번 31-1은 **도로 필지**라 공간상 안 겹친다 → 불일치.
  - **YTN서울타워: juso·대장은 산1-3인데 외곽선은 100% 산1-11 위**(대장의 부속지번). 산1-3 안에서 찾은 건물 목록에도 없다.
  - 남산공원길 126: 산1-3 82.8% + 산1-1 17.2% → 건물 → 필지 2.
  - 낭성면 행정복지센터: 120-3 78.7% + 34-6 17.0% + 262-3 4.3% → **대장 부속지번과 정확히 일치**.
  - 정원팰리스 126-52: 101~103동 100% 안. 옆 건물(126-50)이 126-52에 3.5%(3.4㎡) 걸침.
  - 블로그 예시 상봉동 126-39: **연속지적도에 없다**(NOT_FOUND). 표제부·도로명주소 건물도 0건 → 지금은 없는 필지일 가능성(합필 등).

**아직 확인 안 된 것 (구현 중 실제 응답으로 확인하고 이 목록에서 지운다):**

- [ ] `relJibun`이 여러 개일 때 구분 형식, 대장 부속지번과 어떤 관계인지
- [ ] 총괄표제부와 그 아래 표제부를 잇는 키(낭성면처럼 지번이 안 맞는 경우)
- [ ] **경계 접촉 기준값.** 대장으로 확인된 실제 걸침 중 최소가 4.3%(낭성 262-3), 대장 근거 없는 겹침이 3.5%(126-50 → 126-52)라 지금 사례로는 못 가른다. 임시 1%(`EDGE_CONTACT_RATIO`), 비율 값을 결과에 같이 준다. 사례를 더 모아 정한다
  - 추가 사례(2026-11-25, 사용자 질의로 본 서울 주거지 필지 하나 — 개인 주소라 기록하지 않음): 한 건물이 주변 5필지에 0.1·0.6·0.7·0.7·0.8%씩 닿고, 옆 건물이 0.4% 닿음 → **측량 오차로 보이는 접촉은 0.1~0.8%에 몰린다.** 같은 건물이 다른 한 필지에 2.0%(2.2㎡) 걸침, 대장 근거 없음.
  - 지금까지: 오차로 보이는 접촉 0.1~0.8% / 대장 근거 없는 겹침 2.0%·3.5% / 대장으로 확인된 걸침 4.3%. → 1%는 오차 구간 바로 위라 경계 접촉 기준으로는 맞아 보인다. 2~5%는 `small_overlap` 안내 구간으로 둔다.
- [ ] 상봉동 126-39가 언제·어떻게 없어졌는지(합필 등) — 블로그 글감
- [ ] 브이월드 WMTS 일일 호출 한도, 배경지도 갱신 주기(타일 캐시 기간 정하기)
- [ ] 브이월드 인증키를 두 번째로 발급받을 수 없는 이유(계정당 제한인지, 화면 문제인지 — 고객센터 1661-0115)
- [ ] 각 키의 유효기간·일일 한도 (juso는 **개발용** 키로 발급받음 → 기간 제한 있음)

---

## 4. 아키텍처

```
packages/core (TypeScript)        ← 모든 로직은 여기
  address · pnu · ledger(대장) · spatial(공간) · relation(분류) · cache
      ▲                    ▲
      │                    │
packages/mcp               apps/web (Next.js)
  MCP 서버 (stdio)           조회 화면 + 지도(필지·건물 외곽선 겹쳐 표시)
  npx로 로컬 실행             Route Handler가 core 호출
```

- **공공 API 키를 브라우저에 노출하지 않는다.** 웹은 서버(Route Handler)에서만 호출한다.
- MCP 서버는 사용자 PC에서 돌고 **사용자 본인의 API 키**를 환경변수로 받는다 → 우리 쪽 비용·한도와 무관.
- 겹침 계산: 1단계는 Turf.js(메모리 계산). 필지·건물 수가 적어 충분하다. PostGIS는 캐시를 DB로 옮길 때 같이 검토.
- 소스별 타임아웃 5초, 한 소스가 실패해도 나머지 결과는 보여 준다(`status: ok | empty | error`).

### 4-1. 관계 판정 규칙 (구현: `relation.ts`, `analyze.ts`)

- 표기는 **건물 수 : 필지 수**. `1:1` / `1:N` 건물 하나가 여러 필지 / `N:1` 한 필지에 여러 동, 모두 그 안 / `N:M` 한 필지의 건물 중 일부가 다른 필지에도 걸침.
- 출발점: PNU·지번주소 → **필지 출발**(그 필지의 건물들 + 그 건물들이 걸친 필지들). 도로명주소·건물관리번호·건물명 → **건물 출발**(그 건물이 걸친 필지들, 건물 수는 1로 본다).
- **대장 기준:** 필지 출발이면 그 지번 표제부의 주건축물(없으면 표제부 전부, 표제부가 없으면 총괄표제부)이 건물. 부속지번은 그 대장의 건물에, 노드가 아닌 대장(총괄표제부·부속건축물)의 부속지번은 대지 전체에 붙인다. 건물 출발이면 대표지번 대장 중 **도로명 키**(`naRoadCd`·`naMainBun`·`naSubBun` = juso `rnMgtSn`·`buldMnnm`·`buldSlno`)가 같은 표제부를 이 건물로 본다. 안 맞으면 총괄표제부.
- **공간 기준:** 도로명주소 건물 외곽선과 필지 경계의 겹침. 경계 접촉(건물 면적의 1% 미만)은 관계에서 빼고 `edgeContacts`로 따로.
- `agree`: 관계 종류와 필지 목록이 둘 다 같을 때만 true.
- 불일치 코드: `parcel_not_in_cadastral`, `recap_without_titles`, `ledger_parcel_not_spatial`, `spatial_parcel_not_ledger`, `building_count_differs`, `representative_not_under_building`, `ledger_unmatched`, `small_overlap`.
- **작은 겹침(`small_overlap`):** 건물 면적의 5%(`SMALL_OVERLAP_RATIO`) 미만으로 걸친 것은 관계에 넣되, 실제 걸침인지 오차인지 확실하지 않다고 안내한다. 대장(대지위치·부속지번)이 그 필지를 가리키면 확인된 것으로 보고 안내하지 않는다(낭성면 → 262-3, 4.3%).
- 후보가 여럿이면 판정하지 않고 `ambiguous`로 돌려준다: 건물 후보(`candidates`) 또는 필지 후보(`parcels`, 같은 이름의 법정동이 여러 곳 — 상봉동은 서울 중랑구·경남 진주시).
- **지번주소 → PNU:** ① juso에서 그 지번을 대표지번으로 하는 건물이 있으면 그 PNU ② 없거나 juso가 실패하면 **법정동코드 표**(`findBjdongByName`)로 직접 만든다. juso에 관련지번으로 걸린 건물이 있으면 notes에 적는다. 법정동 이름을 못 찾을 때만 PNU로 물어보라고 안내한다.
- **실패 안내(`incomplete`):** 일부 소스가 실패하면 무엇이 빠졌는지와 함께 종류별 안내를 준다 — `retry`(시간 초과·게이트웨이 05·5xx: 잠시 뒤 같은 질문), `config`(키·도메인: 다시 물어도 같음, 설정 확인), `quota`(일일 한도: 내일). 입력 단계 실패(`status: error`)에도 `retryable`과 안내 문구를 붙인다.

### 4-2. 재시도·큐 검토 (2026-11-25)

- 관찰: 건축HUB는 평소 100ms 안팎인데, **한동안 안 쓰다가 처음 부르면 5초 넘게 멈추는 일이 자주 있다**(이번 세션에서 세 번, 재시도 3회 × 5초를 다 쓰고 실패하거나 겨우 성공). 503(사유코드 05)도 간헐적.
- MCP 서버(사용자 PC, stdio): 도구 호출은 요청-응답이라 큐에 넣고 나중에 알려 주는 흐름이 맞지 않는다. → 요청 안 재시도 + `incomplete` 안내로 사용자가(또는 Claude가) 다시 묻게 한다.
- 웹(Lambda): 8단계에서 **소스별 결과 캐시**(TTL 7일, §6)를 먼저 둔다 — 다시 물으면 성공한 소스는 캐시에서, 실패한 소스만 다시 부른다. 큐(SQS)로 실패 소스를 뒤에서 다시 채우는 방식은 캐시가 있어야 의미가 있고, 실패율을 재 본 뒤 결정한다. 스케줄(EventBridge)로 미리 데워 두는 것은 첫 호출 멈춤이 계속 문제면 검토.
- **실험 (2026-11-25, 약 20분, 요청 52개, 매번 새 연결, 제한 시간 60초, 2초 안에 응답 없으면 hedge 요청 하나 더):**
  - DNS·TCP·TLS는 모두 60ms 이내. **멈춤은 연결이 아니라 게이트웨이 뒤쪽이다.**
  - 결과는 두 가지뿐: 성공은 60~131ms(중앙값 98ms), 실패는 **언제나 약 5.1초(5061~5161ms) 뒤 HTTP 503 + 사유코드 05**(SERVICETIMEOUT_ERROR). 게이트웨이에 5초 백엔드 제한이 있는 것으로 보인다. 우리 쪽 제한 시간 5초가 그보다 살짝 짧아서, 앞서 본 `TIMEOUT`은 사실 503/05를 받기 직전에 우리가 끊은 것이었다.
  - **유휴 시간과는 관계없다.** 유휴 0초에서도 실패하고 10분 쉰 뒤에도 성공. 대신 **시간대로 몰린다**: 처음 4~5분(라운드 0~3)은 거의 모두 실패, 그 뒤로는 대부분 성공. 전체 성공 18/52.
  - 같은 순간에 다시 보내면 잘 안 된다: 첫 요청 성공 14/33, 첫 요청이 2초 넘게 응답 없을 때 보낸 hedge 요청 성공 4/19(21%).
  - 결론: 응답이 1초 안에 안 오면 거의 확실히 5.1초 뒤 503이다 → 5초를 다 기다릴 이유가 없다. 다만 장애가 몇 분씩 이어지는 구간에서는 클라이언트 재시도로 해결되지 않는다 → 빨리 포기하고 `incomplete` 안내 + (웹) 캐시가 맞다.
- **반영:** 건축HUB 시도당 제한 2초(`LEDGER_TIMEOUT_MS`), 재시도 2회(0.5초·1초 간격). 장애 구간에서 실패를 알리기까지 약 16초 → 약 7.5초. 동시 hedge 요청은 효과가 낮아(4/19) 넣지 않는다.

### 4-3. 웹 (구현: `apps/web`)

- Next.js 16(App Router). `/api/analyze?q=`(Route Handler)가 core `analyze` + `presentResult` + `mapFeaturesWithMissing`를 부른다. 키는 서버 환경변수에서만 읽는다. 로컬은 `next.config.ts`가 루트 `.env`를 `process.loadEnvFile`로 읽는다.
- `@pnu/core`는 `serverExternalPackages`(법정동 표를 패키지 기준 상대경로로 읽기 때문에 번들하지 않는다). 타입 검사는 `next typegen && tsc --noEmit`(TS 7이라 Next 내장 검사는 끔).
- 결과 캐시: 메모리 TTL 7일·300개, **완전한 결과만**(`incomplete` 있으면 저장 안 함 → 다시 물으면 다시 조회). IP당 10분 30회 제한. 둘 다 인스턴스 메모리라 DB 캐시 전까지의 1단계.
- 지도: MapLibre GL. 출발 필지(파랑), 건물이 걸친 필지(회색), **대장에만 있는 필지(빨강 점선 — 공간상 건물이 안 걸침, 경계를 따로 받아 온다)**, 건물 외곽선(주황). 글자 라벨은 글꼴 서버가 필요해 빼고 클릭 팝업.
- **배경지도 키:** 브이월드 WMTS `https://api.vworld.kr/req/wmts/1.0.0/{key}/Base/{z}/{y}/{x}.png`(Base 레벨 6~19, 명세 확인). **실제로 Referer를 검사하지 않는다**(다른 도메인 Referer로도 타일이 나옴, 2026-11-25 확인) → 브라우저에 넣는 키는 누구나 쓸 수 있다. 그래서 **배경지도 전용 키**(`NEXT_PUBLIC_VWORLD_TILE_KEY`)를 따로 발급해 쓰고, 데이터 키(`VWORLD_KEY`)는 서버에만 둔다. 전용 키가 없으면 배경 없이 도형만 그린다.
  - **변경(2026-11-25): 전용 키 발급이 막혔다**(이미 키가 하나 있는 계정에서 발급 버튼이 나오지 않음, 서비스URL을 바꿔도 같음 — 원인은 미확인). 기존 키를 브라우저에 쓰면 2D데이터 한도를 남이 쓸 수 있어 쓰지 않는다. → **서버 타일 중계 + CDN 캐시**로 간다(아래 계획). OpenStreetMap 타일(키 없음)은 대안으로 남겨 둔다.

#### 배경지도 — 구현(2026-11-25): CloudFront가 브이월드에서 직접 (Lambda 안 거침)

- 아래 「중계 계획」(Lambda 라우트)보다 싸고 빨라서 바꿨다. 브이월드를 CloudFront 원본으로 두고 키는 원본 경로(`/req/wmts/1.0.0/{{resolve:ssm:/pnu-web/VWORLD_KEY}}/Base`)에. `/tiles/*` 동작에 CloudFront Function(`apps/web/cloudfront/tiles.js`, cloudfront-js-2.0, viewer request)이 레벨 6~19·한국 범위(경도 124~132, 위도 32.9~39)를 검사하고 `/z/y/x.png`로 바꾼다. 캐시 정책 30일.
- 비용: CloudFront Functions 월 200만 회 무료, 요청·전송은 CloudFront 무료 구간 → 검색 1회에 타일 약 50장으로 잡으면 월 약 4만 검색까지 0원. Lambda 콜드 스타트 없음.
- 확인된 사실: 브이월드 타일은 `Cache-Control: max-age=259200`(3일). **범위 밖 레벨(5, 20)에도 HTTP 200 + `application/xml` 오류 본문**을 준다 → 함수에서 막지 않으면 오류가 타일로 캐시된다.
- 배포 확인: 첫 요청 Miss 0.30초, 다음 Hit 0.08초. 도쿄 403, 레벨 5·형식 오류 404(함수가 응답, 원본까지 안 감). 배포된 페이지·API·정적 파일 9개에 키 없음.
- 로컬 `next dev`: `next.config.ts`가 개발 서버 단계에서만 `/tiles/*`를 브이월드로 rewrite(빌드 결과에 키가 들어가지 않게). 배경 끄기 `NEXT_PUBLIC_BASEMAP=none`.

#### (참고) 처음 세운 Lambda 중계 계획 — 위 방식으로 대체

목표: 키를 브라우저에 내보내지 않고 브이월드 배경지도를 쓴다. 서버(Lambda) 호출은 CDN 캐시에 없는 타일만.

1. **라우트** `apps/web/app/api/tiles/[z]/[y]/[x]/route.ts` (GET)
   - 입력 검사: `z` 6~19(Base 레벨, 명세), `x`·`y`는 0 ≤ 값 < 2^z 정수, 확장자 없음.
   - **한국 범위 밖 타일은 거절**(대략 경도 124~132, 위도 33~39를 z별 타일 범위로 바꿔 검사) → 우리 키로 다른 곳 타일을 긁어 가는 것을 막는다.
   - 서버에서 `https://api.vworld.kr/req/wmts/1.0.0/{VWORLD_KEY}/Base/{z}/{y}/{x}.png`를 받아 그대로 돌려준다. 제한 시간 5초. 키는 응답·오류 메시지·로그에 남기지 않는다.
   - 성공: `Content-Type: image/png`, `Cache-Control: public, max-age=2592000, s-maxage=2592000`(30일). 실패: 502 + `Cache-Control: no-store`(오류를 캐시하지 않는다).
   - 요청 제한: 지도를 한 번 움직이면 타일이 수십 장이라 조회 API(10분 30회)와 따로, 넉넉하게(예: IP당 10분 2000장). CDN 캐시에 맞은 요청은 여기까지 오지 않는다.
2. **CDN(CloudFront, 8c 배포 때)**: `/api/tiles/*` 동작은 경로만 캐시 키로 쓴다(쿼리·쿠키·헤더 전달 안 함), 원본의 `Cache-Control`을 따른다. 나머지 경로는 기본 동작(캐시 안 함). 같은 타일은 두 번째부터 CloudFront가 내준다.
3. **화면** `MapView`: raster 소스를 `/api/tiles/{z}/{y}/{x}`(minzoom 6, maxzoom 19, 출처 "© 브이월드")로 바꾸고 `NEXT_PUBLIC_VWORLD_TILE_KEY`는 없앤다(`.env.example`에서도 삭제). 배경 끄기 스위치는 `NEXT_PUBLIC_BASEMAP=vworld|none`.
4. **로컬 개발**: CDN이 없어 타일마다 Next 서버를 거친다. 브라우저 캐시(30일)로 같은 타일 반복 요청은 줄어든다.
5. **테스트**: 입력 검사(레벨·범위·한국 밖), 성공 시 헤더, 실패 시 no-store, 오류 응답에 키가 없는지(가짜 fetch).
6. **확인할 것**: 브이월드 WMTS의 일일 호출 한도(키 신청 화면·명세에 있는지), 타일 갱신 주기(30일 캐시가 적당한지).

### MCP 도구

| 도구                | 입력                         | 출력                                                       |
| ------------------- | ---------------------------- | ---------------------------------------------------------- |
| `resolve_address`   | 주소                         | 후보 목록(지번·도로명·PNU·건물관리번호)                    |
| `decode_pnu`        | PNU                          | 시도/시군구/읍면동/리, 산 여부, 본번/부번 (외부 호출 없음) |
| `parcel_buildings`  | PNU 또는 지번주소            | 이 필지의 건물들(대장 기준 + 공간 기준)                    |
| `building_parcels`  | 도로명주소 또는 건물관리번호 | 이 건물이 걸친 필지들(대표·부속지번 + 겹침 비율)           |
| `classify_relation` | 주소 또는 PNU                | `1:1 / 1:N / N:1 / N:M` + 불일치 목록 + 근거               |

### 디렉토리 (예정)

```
pnu_api/
  docs/design.md
  packages/core/src/{pnu,address,ledger,spatial,relation,cache}.ts
  packages/core/test/          pnu 조립·해독·platGbCd 매핑, 관계 분류(fixture)
  packages/core/fixtures/      실제 응답 샘플: 1:1, 1:N, N:1, N:M 사례 각 1개 이상
  packages/mcp/src/server.ts
  apps/web/                    Next.js (App Router)
  data/bjdong_codes.tsv
  .env.example                 JUSO_KEY, DATA_GO_KR_KEY, VWORLD_KEY
  .github/workflows/           테스트 + 배포
```

---

## 5. 기술 스택

| 층        | 선택                                          | 이유                                     |
| --------- | --------------------------------------------- | ---------------------------------------- |
| 언어      | TypeScript                                    | MCP SDK·Next.js와 한 언어로 코드 공유    |
| MCP       | 공식 TypeScript SDK, stdio                    | Claude Code·Claude Desktop에서 바로 연결 |
| 웹        | Next.js(App Router)                           |                                          |
| 지도      | MapLibre GL 또는 OpenLayers + VWorld 배경지도 | 구현 때 결정                             |
| 공간 계산 | Turf.js                                       | 서버 없이 겹침 계산                      |
| DB(선택)  | PostgreSQL + PostGIS                          | 캐시·조회 기록이 필요해지면              |
| 배포      | AWS Lambda(웹 API) + GitHub Actions           | 요청이 적을 때 비용 0에 가깝다           |

---

## 6. 운영 비용

공공 API는 모두 **무료**다. 비용은 웹 호스팅과 DB에서만 나온다. MCP 서버는 사용자 PC에서 돌기 때문에 서버 비용이 없다.

| 구성                                                                         | 월 비용 (추정)    | 비고                                                                                          |
| ---------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| **A. 최소** — 웹: AWS Lambda(함수 URL) 또는 Vercel Hobby, DB 없음            | **0원**           | Lambda 상시 무료 구간: 월 100만 요청 + 40만 GB-초. 개인 블로그 도구 트래픽이면 넘을 일이 없다 |
| **B. DB 포함(권장)** — A + PostgreSQL/PostGIS를 Neon 또는 Supabase 무료 플랜 | **0원**           | 무료 플랜은 용량 제한(수백 MB)과 미사용 시 일시정지가 있다. 캐시 용도로 충분                  |
| C. AWS 정석 — Lambda + RDS PostgreSQL 최소 사양                              | 약 **2만~3만 원** | DB 인스턴스가 24시간 켜져 있어서 생기는 비용. 신규 AWS 계정은 12개월 무료 구간 있음           |
| D. EKS(쿠버네티스)                                                           | **10만 원 이상**  | 클러스터 관리 비용만 시간당 0.1달러(월 약 73달러) + 노드. 이 규모엔 비추천                    |

- 금액은 2026년 기준 공개 요금을 바탕으로 한 추정이다. 배포 전에 AWS 요금 계산기로 다시 확인한다.
- 확인(2026-11-25, AWS 공식 페이지): Lambda 상시 무료 월 100만 요청 + 40만 GB-초. CloudFront 종량제 무료 월 1TB 전송 + 1,000만 요청(별도 상품인 월 정액 Free 플랜은 Free Tier 계정에서 못 쓴다는 조건이 있어 쓰지 않는다). ACM 공개 인증서 무료. **Secrets Manager는 비밀 하나에 월 $0.40 → 키는 SSM Parameter Store 표준 파라미터(저장 무료)에 둔다.**
- **실제 한계는 돈이 아니라 공공 API 일일 호출 한도다.** 공공데이터포털 개발계정은 서비스마다 일일 한도가 있고, 운영계정을 신청하면 늘어난다(무료). 그래서 웹에서는 결과 캐시를 둔다(필지·건물 데이터는 자주 안 바뀜, TTL 7일).
- 공개 웹에서 누구나 조회하면 우리 키의 한도를 남이 쓰게 된다 → IP당 요청 제한을 둔다.
- 도메인은 기존 블로그 도메인의 하위 주소를 쓰면 추가 비용이 없다.

권장: **B로 시작.** 월 0원으로 전체 스택(Next.js, TypeScript, PostgreSQL, Lambda, GitHub Actions)을 모두 쓴다. 트래픽이 생기면 C로 옮긴다.

---

## 7. 작업 순서

1. [x] 키 발급 — `JUSO_KEY`, `DATA_GO_KR_KEY`, `VWORLD_KEY` 모두 `.env`에 있음
2. [x] `core/pnu.ts` + 테스트 (조립·해독·platGbCd 매핑·건물관리번호 분해), 법정동 해독, MCP `decode_pnu` — 커밋 d6aef0e, CI 통과
3. [x] juso 연동 → 주소 종류 판별(`classifyInput`)과 후보 목록(`searchAddress`), fixture 8개로 정규화 테스트 — `core/src/address.ts`
4. [x] 대장 조회(표제부·총괄표제부·부속지번) — `core/src/ledger.ts` `lookupParcelLedger`(소스별 `ok | empty | error`), fixture 14개
5. [x] 공간 조회(연속지적도 `LP_PA_CBND_BUBUN`·도로명주소 건물 `LT_C_SPBD`) + Turf.js 겹침 계산 — `core/src/spatial.ts` `spatialParcelBuildings`·`spatialBuildingParcels`, fixture 20개
6. [x] 관계 분류 + 불일치 판정 — `core/src/relation.ts`(계산), `core/src/analyze.ts`(`analyze(input)`이 출발점 결정·조회·판정). 실제 사례 테스트: 1:1(남산공원길 105 공간), 1:N(낭성면), N:1(정원팰리스 대장), N:M(서울시청 대장, 정원팰리스 공간). §4-1 참고
7. [x] MCP 도구 4개 추가(`resolve_address`, `parcel_buildings`, `building_parcels`, `classify_relation`) — 응답은 도형·원 응답을 빼고 PNU별 지번주소·한 줄 요약을 붙인다(2~3KB). stdio로 실제 API 호출 확인. `.mcp.json`(키 없음, `.env`를 읽음). Claude Code에서 "남산공원길 105 건물이 필지 몇 개에 걸쳐 있어?"로 확인(2026-11-25)
8. [x] 8a [x] Next.js 화면 로컬 동작(§4-3) — 검색·결과 패널·지도·API·캐시·요청 제한. 8b [x] 배경지도: 전용 키 발급이 막혀 **CloudFront가 브이월드에서 직접**(§4-3 「배경지도 — 구현」). 8c [x] Lambda 배포 — `https://pnu.reddol18.pe.kr`.
   - **현재 상태(2026-11-25):** GitHub에 푸시·CI 통과(`109eb89`). 사용자가 AWS CLI(2.32+) 설치 후 `aws login`까지 마침 → 다음 세션은 `aws sts get-caller-identity`로 계정만 확인하고 시작한다. 리소스를 만드는 명령은 무엇을 만드는지·비용을 먼저 보여 주고 확인받은 뒤 실행.
   - **정한 것:** 리전 서울(`ap-northeast-2`), CloudFront용 ACM 인증서만 `us-east-1`. API 키는 Secrets Manager(비밀 하나에 월 $0.40) 대신 **SSM Parameter Store 표준 파라미터**(저장 무료). CloudWatch 로그 보관 7일. 결제 예산 알림 $1 권장.
   - **도메인:** `reddol18.pe.kr` DNS는 가비아(`ns.gabia.co.kr` 등), 루트 A 레코드 4개는 블로그(GitHub Pages) — 건드리지 않는다. 순서: ① ACM 인증서 신청 → 확인용 CNAME을 가비아에 추가 ② CloudFront 대체 도메인 `pnu.reddol18.pe.kr` + 인증서 ③ 가비아에 `pnu` CNAME → `dXXXX.cloudfront.net`.
   - **정한 방식(2026-11-25):** OpenNext가 아니라 **Next standalone + AWS Lambda Web Adapter**(레이어 `LambdaAdapterLayerX86:30` = 1.1.0, 서울 리전에서 조회로 확인). 앱이 정적 페이지 + API 하나라 단순한 쪽. 스택 하나(`infra/template.yaml`): Lambda(nodejs22.x, 1024MB, 30초) + 함수 URL(AWS_IAM) + CloudFront OAC(함수 URL은 `InvokeFunctionUrl`·`InvokeFunction` 두 권한 필요, 2025-10~) + 로그 7일 + 예산 $1 알림. 키는 SSM `/pnu-web/*`(String, 표준)를 `{{resolve:ssm:…}}`로 Lambda 환경변수에.
   - **빌드는 GitHub Actions(`build-lambda`)에서**, 배포는 로컬 `node infra/deploy.mjs <zip>`(`AWS_CLI`, `BUDGET_EMAIL` 환경변수). GitHub에 AWS 권한을 주지 않는다. 겪은 함정:
     - `serverExternalPackages`로 뺀 워크스페이스 패키지(@pnu/core)는 standalone 추적에서 빠진다(Linux도) → core를 번들에 넣고 법정동 표 경로는 `PNU_BJDONG_TSV`(run.sh·next.config가 넣음).
     - pnpm 기본 구조(.pnpm + 링크)를 `cp -rL`로 풀면 next가 `@swc/helpers`를 못 찾는다. Lambda zip의 심볼릭 링크 보존은 AWS 문서에 없다 → CI에서만 `pnpm-workspace.yaml`에 `nodeLinker: hoisted`를 덧붙여 평평하게 설치(명령줄 `--config.node-linker`는 pnpm 12에서 안 먹었다).
     - Windows AWS CLI는 템플릿을 CP949로 읽어 한글 주석에서 실패 → `AWS_CLI_FILE_ENCODING=UTF-8`.
   - **배포 결과(2026-11-25):** 스택 `pnu-web`, CloudFront `E3BARCV2I0L8QQ` = `d2pg5onr26vn0x.cloudfront.net`. 페이지·API(실제 키) 동작, 함수 URL 직접 호출은 403. zip 14.6MB(풀면 47.9MB). 가비아 `pnu` CNAME → `d2pg5onr26vn0x.cloudfront.net` 추가 후 **`https://pnu.reddol18.pe.kr` 동작 확인**(HTTPS 200, http→https 301, API 정상). Lambda 동시 실행 한도 1000. 원래 항목: Next.js 화면(지도에 필지·건물 겹쳐 표시) + Lambda 배포
9. [ ] **← 다음 작업.** 블로그 글 ① 건물과 필지가 1:1이 아닐 때 ② MCP 서버로 만들기. 기존 `/make-pnu-code`, `/land-use-api`에서 링크

## 8. 2단계 이후

- 땅 정보 카드(v0.1 범위): 지목·면적, 용도지역, 공시지가 추이
- 집합건물 전유부(호) 단위
- 건물 단위 데이터 묶기: 법정 점검 대상 판정, 에너지 사용량

## 9. 리스크

- 공공 API 지연·장애·스키마 변경 → 타임아웃, 캐시, 실패 격리, fixture 테스트
- 대장과 공간 데이터의 기준일이 다르다 → 결과에 각 데이터 기준일 표시, 불일치를 오류가 아니라 정보로 보여 준다
- 부속지번 역방향 조회 불가 가능성 → 공간 기준으로 보완(§2-3)
- 개인정보: 지번은 공개 정보지만 조회 로그에 입력 주소를 남기지 않는다

## 10. 결정 사항 (2026-11-25)

- **레포: GitHub 공개.** 키는 절대 커밋하지 않는다(`.env`는 gitignore, CI는 GitHub Secrets).
- **웹 주소: `https://pnu.reddol18.pe.kr`.** VWorld·juso 운영키 신청 시 이 주소를 등록한다. 연결은 DNS에 `pnu` CNAME 한 줄 + (AWS면) CloudFront + ACM 인증서(us-east-1). 비용 없음.
- **API 키: 새로 발급받는다.** 예전 키는 찾지 않는다.

### 키 발급 목록

| 키               | 어디서                                      | 신청할 것                                             | 비고                                                 |
| ---------------- | ------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `JUSO_KEY`       | 도로명주소 개발자센터 (business.juso.go.kr) | 도로명주소 **검색 API** 승인키                        | 개발키로 시작, 배포 때 운영키(서비스 URL 등록)       |
| `DATA_GO_KR_KEY` | 공공데이터포털 (data.go.kr)                 | 국토교통부 **건축HUB 건축물대장정보 서비스** 활용신청 | 키 하나로 여러 서비스 공용. 법정동코드 파일도 여기서 |
| `VWORLD_KEY`     | 브이월드 오픈API (vworld.kr)                | 인증키 발급 — 2D데이터·2D 지도·WMTS/TMS·지오코더 API  | 서비스 URL은 `https://pnu.reddol18.pe.kr` 하나 등록  |

- 각 키의 유효기간, 개발→운영 전환 조건, 일일 한도는 신청 화면에서 확인해 이 표에 적는다.
- 발급 직후 키가 동작하기까지 시간이 걸리는 경우가 있다(공공데이터포털은 보통 수 시간 내). 구현 2~3단계 전에 미리 신청한다.

- **레포 이름: `pnu_api_mcp`** (github.com/reddol18/pnu_api_mcp)
