#!/usr/bin/env node
/**
 * pnu-web 배포: Lambda zip을 S3에 올리고 CloudFormation 스택(infra/template.yaml)을 만들거나 갱신한다.
 *
 * 사용:
 *   node infra/deploy.mjs <lambda zip 경로> [--certificate-arn arn:...] [--param Key=Value ...] [--plan | --preview]
 *   --plan     계정·버킷·인증서·함수 코드 크기만 확인
 *   --preview  CloudFormation 변경 목록만 만들어 보여 주고 지운다(적용 안 함)
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
// 첫 인자가 zip 경로 (--certificate-arn 값이 zip으로 잘못 잡히지 않게)
const zip = args[0]?.startsWith('--') ? undefined : args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const planOnly = args.includes('--plan');
// --param Key=Value (여러 번): 템플릿 파라미터 바꾸기. 예: --param MemorySize=512 --param ReservedConcurrency=100
// 주지 않은 파라미터는 cloudformation deploy가 스택의 기존 값을 쓴다
// Guard*: 의심 접속 자동 차단(이슈 #8). 기준값(GuardMaxRequests·GuardMaxErrors)은 처음 한 번만 주면 스택에 남는다
const ALLOWED_PARAMS = new Set([
  'MemorySize',
  'ReservedConcurrency',
  'KillSwitchGbSeconds',
  'GuardMaxRequests',
  'GuardMaxErrors',
  'GuardWindowMinutes',
  'GuardBlockHours',
  'GuardDryRun',
]);
const extraParams = args.flatMap((a, i) => (a === '--param' && args[i + 1] ? [args[i + 1]] : []));
for (const p of extraParams) {
  const name = p.split('=')[0] ?? '';
  if (!ALLOWED_PARAMS.has(name) || !p.includes('=')) {
    console.error(`--param은 ${[...ALLOWED_PARAMS].join('·')}=값만 받습니다: ${p}`);
    process.exit(2);
  }
}
// biome-ignore lint/suspicious/noUndeclaredEnvVars: turbo 태스크가 아닌 배포 스크립트
const aws = process.env.AWS_CLI || 'aws';
// biome-ignore lint/suspicious/noUndeclaredEnvVars: turbo 태스크가 아닌 배포 스크립트
const region = process.env.AWS_REGION || 'ap-northeast-2';
const stack = 'pnu-web';
const templateSource = path.join(import.meta.dirname, 'template.yaml');
const cloudfrontDir = path.join(import.meta.dirname, '../apps/web/cloudfront');
// 템플릿 자리표시 → 코드 원본(원본은 apps/web/cloudfront 한 곳에만 둔다, 테스트도 이 파일을 읽는다)
const INLINE_CODE = {
  __TILES_FUNCTION_CODE__: { file: 'tiles.js', limit: 10240, label: 'CloudFront Function(타일)' },
  __GUARD_FUNCTION_CODE__: { file: 'guard.js', limit: 10240, label: 'CloudFront Function(문지기)' },
  __GUARD_UPDATER_CODE__: { file: 'guard-updater.cjs', limit: 4096, label: '차단 갱신 Lambda(인라인)' },
};

/**
 * 템플릿 사본에 코드를 끼워 넣는다. 주석만 있는 줄은 뺀다(크기 제한·가독성). YAML 블록 문자열로 넣는다.
 */
function buildTemplate() {
  let yaml = readFileSync(templateSource, 'utf8');
  for (const [name, { file, limit, label }] of Object.entries(INLINE_CODE)) {
    const code = readFileSync(path.join(cloudfrontDir, file), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
      .trim();
    const marker = new RegExp(`^(\\s*)(FunctionCode|ZipFile): ${name}\\s*$`, 'm');
    const m = yaml.match(marker);
    if (!m) throw new Error(`템플릿에 ${name} 자리가 없습니다`);
    const size = Buffer.byteLength(code);
    if (size > limit) throw new Error(`${label} 코드가 ${size} bytes로 상한 ${limit}을 넘습니다`);
    const indent = `${m[1]}  `;
    const block = `${m[1]}${m[2]}: |\n${code
      .split('\n')
      .map((l) => (l ? indent + l : ''))
      .join('\n')}`;
    yaml = yaml.replace(marker, () => block);
    console.log(`${label} 코드 ${size} bytes`);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pnu-web-cfn-'));
  const outFile = path.join(dir, 'template.yaml');
  writeFileSync(outFile, yaml);
  return { file: outFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
const template = buildTemplate();
process.on('exit', template.cleanup);
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

const deployArgs = [
  'cloudformation',
  'deploy',
  '--stack-name',
  stack,
  '--template-file',
  template.file,
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
  ...extraParams,
];

if (args.includes('--preview')) {
  // 적용하지 않고 변경 목록만 만든다(사용자에게 보여 주고 확인받기 위해)
  const out = run([...deployArgs, '--no-execute-changeset']);
  const arn = out.match(/arn:aws:cloudformation:[^\s]+:changeSet\/[^\s]+/)?.[0];
  if (!arn) {
    console.log(out.trim() || '바뀌는 것이 없습니다');
    process.exit(0);
  }
  const cs = JSON.parse(run(['cloudformation', 'describe-change-set', '--change-set-name', arn, '--output', 'json']));
  console.log('\n변경 목록 (적용 안 함):');
  for (const c of cs.Changes ?? []) {
    const r = c.ResourceChange;
    const props = (r.Details ?? []).map((d) => d.Target?.Name).filter(Boolean);
    const extra = r.Replacement === 'True' ? ' [교체]' : '';
    console.log(`  ${r.Action.padEnd(7)} ${r.ResourceType.padEnd(36)} ${r.LogicalResourceId}${extra}`);
    if (props.length) console.log(`          바뀌는 속성: ${[...new Set(props)].join(', ')}`);
  }
  run(['cloudformation', 'delete-change-set', '--change-set-name', arn]);
  process.exit(0);
}

console.log('CloudFormation 배포… (CloudFront를 만들거나 바꿀 때는 수 분 걸립니다)');
run(deployArgs, { inherit: true });

const outputs = JSON.parse(
  run(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json']),
);
for (const o of outputs) console.log(`${o.OutputKey}: ${o.OutputValue}`);

// 안내 페이지(이슈 #5): Lambda가 거절할 때 CloudFront가 이 파일을 보여 준다
const maintenanceBucket = outputs.find((o) => o.OutputKey === 'MaintenanceBucket')?.OutputValue;
if (maintenanceBucket) {
  run([
    's3',
    'cp',
    path.join(import.meta.dirname, 'maintenance.html'),
    `s3://${maintenanceBucket}/maintenance.html`,
    '--content-type',
    'text/html; charset=utf-8',
    '--cache-control',
    'max-age=300',
    '--only-show-errors',
  ]);
  console.log(`안내 페이지 올림: s3://${maintenanceBucket}/maintenance.html`);
}
