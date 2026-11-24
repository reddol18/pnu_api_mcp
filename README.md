# pnu_api_mcp

주소나 PNU(필지고유번호)를 넣으면 **건물과 필지의 관계**(건물 하나가 여러 필지에 걸쳤는지, 필지 하나에 건물이 여러 동인지)를 건축물대장과 공간 데이터로 판정하는 도구. Claude에서 쓰는 MCP 서버와 웹 조회 화면으로 제공한다.

- 설계: [docs/design.md](docs/design.md)
- 상태: 개발 중 — PNU 조립·해독과 MCP `decode_pnu` 도구까지 동작 (2026-11-25)

## 지금 되는 것

`decode_pnu` — 19자리 PNU를 풀어 준다. 외부 API·키 없이 동작한다.

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

Claude Code에 로컬 빌드로 연결:

```bash
claude mcp add pnu -- node <이 저장소>/packages/mcp/dist/cli.js
```

## 라이선스

MIT
