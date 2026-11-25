import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type AnalyzeOptions,
  analyze,
  classifyInput,
  decodePnu,
  findBjdongByName,
  formatJibun,
  formatPnu,
  type InputKind,
  JusoError,
  PnuError,
  parseAddressNumber,
  pnuToLedgerKey,
  presentCandidate,
  presentResult,
  searchAddress,
} from '@pnu/core';
import { z } from 'zod';

export interface ServerDeps {
  /** 사용자 본인의 API 키 (환경변수 JUSO_KEY, DATA_GO_KR_KEY, VWORLD_KEY, VWORLD_DOMAIN) */
  keys: Pick<AnalyzeOptions, 'jusoKey' | 'dataGoKrKey' | 'vworldKey' | 'vworldDomain'>;
  /** 테스트용 */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  return {
    keys: {
      jusoKey: env.JUSO_KEY ?? '',
      dataGoKrKey: env.DATA_GO_KR_KEY ?? '',
      vworldKey: env.VWORLD_KEY ?? '',
      vworldDomain: env.VWORLD_DOMAIN ?? '',
    },
  };
}

const json = (body: unknown, isError = false) => ({
  ...(isError && { isError: true }),
  content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
});

const INPUT_HELP =
  '지번주소(예: 서울특별시 중랑구 상봉동 126-39, 용산동2가 산1-3), 도로명주소(예: 세종대로 110), ' +
  '19자리 PNU, 25자리 건물관리번호, 건물명(예: 낭성면 행정복지센터)';

const PARCEL_KINDS: InputKind[] = ['pnu', 'jibun'];
const BUILDING_KINDS: InputKind[] = ['road', 'buildingMgmtNo', 'unknown'];

export function createServer(deps: ServerDeps = depsFromEnv()): McpServer {
  const server = new McpServer({ name: 'pnu_api_mcp', version: '0.2.0' });
  const opts = (): AnalyzeOptions => ({
    ...deps.keys,
    ...(deps.fetch && { fetch: deps.fetch }),
    ...(deps.sleep && { sleep: deps.sleep }),
  });

  async function run(input: string) {
    const r = await analyze(input, opts());
    return json(presentResult(r), r.status === 'error');
  }

  server.registerTool(
    'decode_pnu',
    {
      title: 'PNU 해독',
      description:
        '19자리 PNU(필지고유번호)를 법정동(시도·시군구·읍면동·리), 산 여부, 본번·부번, 지번주소로 풀어 준다. ' +
        '건축물대장 조회 키(sigunguCd·bjdongCd·platGbCd·bun·ji)도 함께 돌려준다. 외부 API를 호출하지 않는다.',
      inputSchema: { pnu: z.string().describe('19자리 PNU, 예: 1126010200101260039') },
    },
    async ({ pnu }) => {
      try {
        const d = decodePnu(pnu);
        return json({ ...d, ledgerKey: pnuToLedgerKey(d) });
      } catch (e) {
        if (e instanceof PnuError) return { isError: true, content: [{ type: 'text', text: e.message }] };
        throw e;
      }
    },
  );

  server.registerTool(
    'resolve_address',
    {
      title: '주소 → 후보',
      description:
        '주소·건물명을 도로명주소 검색(juso)으로 찾아 후보 목록(도로명·지번주소, 건물명, 대표지번 PNU, 건물관리번호)을 돌려준다. ' +
        '지번주소면 법정동코드 표로 만든 필지 PNU 후보도 함께 준다(도로·빈 땅처럼 건물이 없는 필지도 PNU를 얻을 수 있다). ' +
        '관계 판정은 하지 않는다 — 후보를 고른 뒤 parcel_buildings·building_parcels·classify_relation을 쓴다.',
      inputSchema: { query: z.string().describe(INPUT_HELP) },
    },
    async ({ query }) => {
      const s = query.trim();
      const inputKind = classifyInput(s);
      if (inputKind === 'pnu') {
        try {
          return json({ inputKind, parcel: decodePnu(s) });
        } catch (e) {
          if (e instanceof PnuError) return { isError: true, content: [{ type: 'text', text: e.message }] };
          throw e;
        }
      }
      if (inputKind === 'buildingMgmtNo') {
        return json({
          inputKind,
          message:
            '건물관리번호는 주소 검색어로 쓸 수 없다. building_parcels나 classify_relation에 그대로 넣으면 된다.',
        });
      }
      const num = parseAddressNumber(s);
      const parcels =
        inputKind === 'jibun' && num && num.main >= 1 && num.main <= 9999 && num.sub <= 9999
          ? findBjdongByName(num.head).map((e) => {
              const lot = { mountain: num.mountain, bonbun: num.main, bubun: num.sub };
              return { pnu: formatPnu({ bjdongCode: e.code, ...lot }), jibunAddress: `${e.name} ${formatJibun(lot)}` };
            })
          : [];
      try {
        const r = await searchAddress(s, {
          key: deps.keys.jusoKey ?? '',
          countPerPage: 20,
          ...(deps.fetch && { fetch: deps.fetch }),
        });
        return json({
          inputKind,
          totalCount: r.totalCount,
          candidates: r.candidates.map(presentCandidate),
          ...(inputKind === 'jibun' && { parcels }),
        });
      } catch (e) {
        const code = e instanceof JusoError ? e.code : 'UNKNOWN';
        const message = e instanceof Error ? e.message : String(e);
        // 지번주소면 juso가 실패해도 법정동코드 표 후보는 줄 수 있다
        return json(
          { inputKind, error: { code, message }, ...(inputKind === 'jibun' && { parcels }) },
          !parcels.length,
        );
      }
    },
  );

  server.registerTool(
    'parcel_buildings',
    {
      title: '필지 → 건물들',
      description:
        '필지(PNU 또는 지번주소) 위의 건물들을 대장 기준(표제부·총괄표제부·부속지번)과 공간 기준(건물 외곽선 겹침)으로 따로 보여 주고, ' +
        '그 건물들이 다른 필지에도 걸쳤는지까지 본다. 관계는 "건물 수 : 필지 수"(1:1, 1:N, N:1, N:M), 두 근거가 다르면 discrepancies에 적는다. ' +
        '일부 공공 API가 실패하면 incomplete에 무엇이 빠졌고 다시 물어보면 되는지 적힌다.',
      inputSchema: {
        input: z.string().describe('19자리 PNU 또는 지번주소. 예: 1114010300100310000, 서울특별시 중구 태평로1가 31'),
      },
    },
    async ({ input }) => {
      const kind = classifyInput(input);
      if (!PARCEL_KINDS.includes(kind)) {
        return json(
          {
            status: 'wrong_tool',
            inputKind: kind,
            message:
              '필지에서 출발하려면 PNU나 지번주소를 넣어야 한다. 도로명주소·건물명·건물관리번호는 building_parcels(그 건물이 걸친 필지들)나 classify_relation을 쓰라.',
          },
          true,
        );
      }
      return run(input);
    },
  );

  server.registerTool(
    'building_parcels',
    {
      title: '건물 → 필지들',
      description:
        '건물(도로명주소, 건물관리번호, 건물명)이 걸친 필지들을 대장 기준(대표지번·부속지번)과 공간 기준(외곽선이 겹친 필지와 겹침 비율)으로 따로 보여 준다. ' +
        '주소의 대표지번 위에 실제 건물이 없는 경우 등 두 근거가 다르면 discrepancies에 적는다. 후보가 여럿이면 ambiguous로 후보를 돌려준다.',
      inputSchema: {
        input: z.string().describe('도로명주소, 25자리 건물관리번호, 또는 건물명. 예: 남산공원길 105'),
      },
    },
    async ({ input }) => {
      const kind = classifyInput(input);
      if (!BUILDING_KINDS.includes(kind)) {
        return json(
          {
            status: 'wrong_tool',
            inputKind: kind,
            message:
              'PNU·지번주소는 필지를 가리킨다. 그 필지의 건물들은 parcel_buildings로 보고, 특정 건물이 궁금하면 resolve_address로 건물을 찾은 뒤 도로명주소로 다시 물어보라.',
          },
          true,
        );
      }
      return run(input);
    },
  );

  server.registerTool(
    'classify_relation',
    {
      title: '필지-건물 관계 판정',
      description:
        '주소·PNU·건물관리번호·건물명 무엇이든 받아 출발점을 정하고(지번·PNU → 필지, 도로명·건물 → 건물) 관계를 판정한다. ' +
        '결과의 summary에 한 줄 요약, ledger·spatial에 근거별 관계(건물 수 : 필지 수), discrepancies에 불일치, ' +
        'incomplete에 빠진 자료와 재시도 안내가 있다.',
      inputSchema: { input: z.string().describe(INPUT_HELP) },
    },
    async ({ input }) => run(input),
  );

  return server;
}
