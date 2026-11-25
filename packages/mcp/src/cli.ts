#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, depsFromEnv } from './server.js';

// 키는 환경변수로 받는다(JUSO_KEY, DATA_GO_KR_KEY, VWORLD_KEY, VWORLD_DOMAIN).
// 로컬에서는 `node --env-file-if-exists=.env packages/mcp/dist/cli.js` 로 .env를 읽게 한다.
await createServer(depsFromEnv()).connect(new StdioServerTransport());
