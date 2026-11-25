#!/usr/bin/env node
/**
 * pnu-web 배포: Lambda zip을 S3에 올리고 CloudFormation 스택(infra/template.yaml)을 만들거나 갱신한다.
 *
 * 사용:
 *   node infra/deploy.mjs <lambda zip 경로> [--certificate-arn arn:...] [--plan]
 * 환경변수:
 *   AWS_CLI       aws 실행 파일 경로 (기본 "aws")
 *   BUDGET_EMAIL  예산 알림 이메일 (저장소에 넣지 않으려고 환경변수로만 받는다)
 *   AWS_REGION    기본 ap-northeast-2
 *
 * zip은 GitHub Actions의 build-lambda 워크플로가 만든다(Linux 빌드):
 *   gh run download <run-id> -n pnu-web-lambda -D <폴더>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
// 첫 인자가 zip 경로 (--certificate-arn 값이 zip으로 잘못 잡히지 않게)
const zip = args[0]?.startsWith('--') ? undefined : args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const planOnly = args.includes('--plan');
// biome-ignore lint/suspicious/noUndeclaredEnvVars: turbo 태스크가 아닌 배포 스크립트
const aws = process.env.AWS_CLI || 'aws';
// biome-ignore lint/suspicious/noUndeclaredEnvVars: turbo 태스크가 아닌 배포 스크립트
const region = process.env.AWS_REGION || 'ap-northeast-2';
const stack = 'pnu-web';
const templateFile = path.join(import.meta.dirname, 'template.yaml');

if (!zip) {
  console.error('사용: node infra/deploy.mjs <lambda zip> [--certificate-arn arn] [--plan]');
  process.exit(2);
}
// biome-ignore lint/suspicious/noUndeclaredEnvVars: turbo 태스크가 아닌 배포 스크립트
const email = process.env.BUDGET_EMAIL;
if (!email) {
  console.error('BUDGET_EMAIL 환경변수가 필요합니다');
  process.exit(2);
}

function run(argv, opts = {}) {
  return execFileSync(aws, [...argv, '--region', opts.region ?? region], {
    encoding: 'utf8',
    // Windows에서 AWS CLI가 템플릿(한글 주석)을 CP949로 읽다 실패하지 않게
    env: { ...process.env, AWS_CLI_FILE_ENCODING: 'UTF-8' },
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}
function tryRun(argv, opts) {
  try {
    return { ok: true, out: run(argv, opts) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) };
  }
}

const account = JSON.parse(run(['sts', 'get-caller-identity', '--output', 'json'])).Account;
const bucket = `pnu-web-artifacts-${account}`;

// 인증서: 인자로 주지 않으면 us-east-1에서 도메인으로 찾는다
let certArn = flag('--certificate-arn');
if (!certArn) {
  const list = JSON.parse(
    run(['acm', 'list-certificates', '--certificate-statuses', 'ISSUED', '--output', 'json'], { region: 'us-east-1' }),
  );
  certArn = list.CertificateSummaryList.find((c) => c.DomainName === 'pnu.reddol18.pe.kr')?.CertificateArn;
  if (!certArn) throw new Error('us-east-1에 발급된 pnu.reddol18.pe.kr 인증서가 없습니다');
}

const body = readFileSync(zip);
const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
const key = `lambda/pnu-web-${hash}.zip`;

console.log(`계정 ${account}, 리전 ${region}, 스택 ${stack}`);
console.log(`버킷 ${bucket}, 코드 ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`인증서 ${certArn}`);
if (planOnly) {
  console.log('--plan: 여기까지만 확인하고 끝냅니다');
  process.exit(0);
}

// 배포용 버킷 (처음 한 번): 공개 접근 차단, 30일 지난 파일 자동 삭제
if (!tryRun(['s3api', 'head-bucket', '--bucket', bucket]).ok) {
  console.log('버킷 만들기…');
  run(['s3api', 'create-bucket', '--bucket', bucket, '--create-bucket-configuration', `LocationConstraint=${region}`]);
  run([
    's3api',
    'put-public-access-block',
    '--bucket',
    bucket,
    '--public-access-block-configuration',
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
  ]);
  run([
    's3api',
    'put-bucket-lifecycle-configuration',
    '--bucket',
    bucket,
    '--lifecycle-configuration',
    JSON.stringify({
      Rules: [{ ID: 'expire-old-artifacts', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 30 } }],
    }),
  ]);
  run(['s3api', 'put-bucket-tagging', '--bucket', bucket, '--tagging', 'TagSet=[{Key=project,Value=pnu-web}]']);
}

if (!tryRun(['s3api', 'head-object', '--bucket', bucket, '--key', key]).ok) {
  console.log('zip 올리기…');
  run(['s3', 'cp', zip, `s3://${bucket}/${key}`, '--only-show-errors']);
} else {
  console.log('같은 zip이 이미 있어 올리지 않습니다');
}

console.log('CloudFormation 배포… (CloudFront를 처음 만들 때는 수 분 걸립니다)');
run(
  [
    'cloudformation',
    'deploy',
    '--stack-name',
    stack,
    '--template-file',
    templateFile,
    '--capabilities',
    'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    '--tags',
    'project=pnu-web',
    '--parameter-overrides',
    `CodeBucket=${bucket}`,
    `CodeKey=${key}`,
    `CertificateArn=${certArn}`,
    `BudgetEmail=${email}`,
  ],
  { inherit: true },
);

const outputs = JSON.parse(
  run(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json']),
);
for (const o of outputs) console.log(`${o.OutputKey}: ${o.OutputValue}`);
