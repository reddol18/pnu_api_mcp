import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decodePnu, PnuError, pnuToLedgerKey } from '@pnu/core';
import { z } from 'zod';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'pnu_api_mcp', version: '0.1.0' });

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
        const result = { ...d, ledgerKey: pnuToLedgerKey(d) };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof PnuError) {
          return { isError: true, content: [{ type: 'text', text: e.message }] };
        }
        throw e;
      }
    },
  );

  return server;
}
