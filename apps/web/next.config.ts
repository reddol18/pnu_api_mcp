import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(import.meta.dirname, '../..');

// 로컬 개발: 키는 저장소 루트의 .env 하나에 둔다(MCP 서버와 같은 파일). 배포 환경에는 이 파일이 없다.
const rootEnv = path.join(root, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  // @pnu/core는 법정동코드 표(data/bjdong_codes.tsv)를 패키지 기준 상대경로로 읽는다 → 번들하지 않고 node_modules에서 그대로 쓴다
  serverExternalPackages: ['@pnu/core'],
  // 모노레포: 배포 파일 추적·Turbopack 기준을 저장소 루트로
  outputFileTracingRoot: root,
  turbopack: { root },
  // 타입 검사는 turbo의 typecheck 태스크(tsc --noEmit)에서 한다
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default config;
