import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

describe('MCP 서버', () => {
  const client = new Client({ name: 'test', version: '0.0.0' });

  beforeAll(async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer().connect(serverT), client.connect(clientT)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it('decode_pnu 도구가 목록에 있다', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('decode_pnu');
  });

  it('decode_pnu: 상봉동 126-39', async () => {
    const r = await client.callTool({ name: 'decode_pnu', arguments: { pnu: '1126010200101260039' } });
    expect(r.isError).toBeFalsy();
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    const body = JSON.parse(text);
    expect(body.jibunAddress).toBe('서울특별시 중랑구 상봉동 126-39');
    expect(body.ledgerKey).toEqual({ sigunguCd: '11260', bjdongCd: '10200', platGbCd: '0', bun: '0126', ji: '0039' });
  });

  it('decode_pnu: 형식 오류는 isError로 돌려준다', async () => {
    const r = await client.callTool({ name: 'decode_pnu', arguments: { pnu: '123' } });
    expect(r.isError).toBe(true);
  });
});
