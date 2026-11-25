import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.join(import.meta.dirname, '../..');

// 로컬 개발: 키는 저장소 루트의 .env 하나에 둔다(MCP 서버와 같은 파일). 배포 환경에는 이 파일이 없다.
const rootEnv = path.join(root, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// core를 번들에 넣으므로 법정동코드 표 위치를 따로 알려 준다(next dev·build). Lambda에서는 infra/run.sh가 넣는다.
process.env.PNU_BJDONG_TSV ??= path.join(root, 'packages/core/data/bjdong_codes.tsv');

const config: NextConfig = {
  // @pnu/core는 번들에 넣는다. 밖에 두면(serverExternalPackages) standalone 추적이 워크스페이스 링크를 따라가지 못해
  // core가 빠진다(2026-11-25 Linux 빌드에서 확인). 법정동코드 표 경로는 PNU_BJDONG_TSV로 준다.
  // Lambda(Lambda Web Adapter)에 올릴 수 있게 서버와 필요한 node_modules만 모은다 → .next/standalone
  output: 'standalone',
  // 모노레포: 배포 파일 추적·Turbopack 기준을 저장소 루트로
  outputFileTracingRoot: root,
  // core가 실행 중에 읽는 법정동코드 표를 standalone에 꼭 넣는다
  outputFileTracingIncludes: { '/api/analyze': ['../../packages/core/data/**'] },
  turbopack: { root },
  // 타입 검사는 turbo의 typecheck 태스크(tsc --noEmit)에서 한다
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default config;
