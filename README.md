# pnu_api_mcp

주소나 PNU(필지고유번호)를 넣으면 **건물과 필지의 관계**(건물 하나가 여러 필지에 걸쳤는지, 필지 하나에 건물이 여러 동인지)를 건축물대장과 공간 데이터로 판정하는 도구. Claude에서 쓰는 MCP 서버와 웹 조회 화면으로 제공한다.

- 설계: [docs/design.md](docs/design.md)
- 상태: 개발 중 — MCP 도구 5개 동작, 웹은 예정 (2026-11-25)

## MCP 도구

| 도구                | 입력                                  | 하는 일                                                         |
| ------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `classify_relation` | 주소·PNU·건물관리번호·건물명 무엇이든 | 출발점을 정해 관계를 판정. 한 줄 요약 + 대장·공간 근거 + 불일치 |
| `parcel_buildings`  | PNU 또는 지번주소                     | 이 필지의 건물들, 그 건물들이 걸친 다른 필지                    |
| `building_parcels`  | 도로명주소·건물관리번호·건물명        | 이 건물이 걸친 필지들 (대표·부속지번 + 외곽선 겹침 비율)        |
| `resolve_address`   | 주소·건물명                           | 후보 목록. 지번주소면 법정동코드 표로 만든 PNU 후보도           |
| `decode_pnu`        | PNU                                   | PNU 해독. 외부 호출·키 없음                                     |

관계 표기는 **건물 수 : 필지 수**(`1:1`, `1:N`, `N:1`, `N:M`). 대장 기준(표제부·부속지번)과 공간 기준(건물 외곽선 겹침)을 따로 판정하고, 둘이 다르면 `discrepancies`에 적는다. 예) `남산공원길 105` → 대장은 산1-3·산1-11(1:N)인데 YTN서울타워 외곽선은 산1-11 위에만 있다(1:1) — 주소의 대표지번 위에 건물이 없다.

공공 API가 잠깐 응답하지 않으면 결과의 `incomplete`에 빠진 자료와 "잠시 후 다시 물어보면 된다"는 안내가 붙는다.

### 필요한 키 (본인 키, 무료)

`.env.example`을 `.env`로 복사해 채운다: `JUSO_KEY`(도로명주소 검색 API), `DATA_GO_KR_KEY`(건축HUB 건축물대장정보), `VWORLD_KEY` + `VWORLD_DOMAIN`(브이월드 2D데이터, 키 발급 때 등록한 서비스 URL — 서버 호출에 꼭 필요).

### `decode_pnu` 예

입력 `1126010200101260039`의 결과(일부):

```json
{
  "sido": "서울특별시",
  "sigungu": "중랑구",
  "eupmyeondong": "상봉동",
  "ri": null,
  "mountain": false,
  "bonbun": 126,
  "bubun": 39,
  "jibunAddress": "서울특별시 중랑구 상봉동 126-39",
  "ledgerKey": { "sigunguCd": "11260", "bjdongCd": "10200", "platGbCd": "0", "bun": "0126", "ji": "0039" }
}
```

`ledgerKey`는 건축물대장 API 조회 키다. 필지구분 값이 PNU(1=일반, 2=산)와 달리 `platGbCd`(0=대지, 1=산)라서 따로 돌려준다.

법정동코드는 2022년 4월판 스냅숏이다(`packages/core/data/bjdong_codes.tsv`). 최신판으로 교체 예정.

## 개발

Node 22 이상, pnpm.

```bash
pnpm install
pnpm lint
pnpm turbo run typecheck test build
```

Claude Code에 로컬 빌드로 연결: 저장소 루트의 `.mcp.json`이 `node --env-file-if-exists=.env packages/mcp/dist/cli.js`를 띄운다(빌드 후 이 폴더에서 Claude Code를 열고 `/mcp`로 승인). 다른 곳에서 쓰려면:

```bash
claude mcp add pnu -e JUSO_KEY=... -e DATA_GO_KR_KEY=... -e VWORLD_KEY=... -e VWORLD_DOMAIN=... -- node <이 저장소>/packages/mcp/dist/cli.js
```

## 라이선스

MIT
