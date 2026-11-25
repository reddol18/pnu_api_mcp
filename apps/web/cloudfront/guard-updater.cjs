// 차단 갱신 Lambda pnu-web-guard (이슈 #8). EventBridge가 10분마다 부른다.
// 요청 로그(/aws/lambda/pnu-web, {"log":"access",...})에서 최근 WINDOW_MINUTES분 동안 요청 수·4xx/5xx 수가
// 기준을 넘은 IP를 찾아 문지기 CloudFront Function(guard.js)의 BLOCKED 줄에 넣고 다시 게시한다.
// 차단은 BLOCK_HOURS 뒤 저절로 풀린다(함수가 시각을 보고, 다음 갱신 때 목록에서도 뺀다).
// DRY_RUN=true면 무엇을 막을지 로그만 남긴다.
// 기준값은 스택 파라미터로만 준다(공개 저장소에 적지 않는다). deploy.mjs가 주석 줄을 빼고 템플릿에 끼워 넣는다.

const BLOCKED_LINE = /^var BLOCKED = (\{.*\});$/m;
// CloudFront Function 코드 크기 상한(바이트)
const CODE_LIMIT = 10240;

function parseBlocked(code) {
  const m = BLOCKED_LINE.exec(code);
  if (!m) throw new Error('guard 함수에 BLOCKED 줄이 없다');
  return JSON.parse(m[1]);
}

function sortedJson(map) {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))));
}

function writeBlocked(code, map) {
  return code.replace(BLOCKED_LINE, () => `var BLOCKED = ${sortedJson(map)};`);
}

// 기한 지난 것 빼고, 새로 걸린 IP는 now+blockSec까지(이미 있으면 늘린다). 많으면 늦게 풀리는 것부터 max개
function nextBlocked(current, offenders, now, blockSec, max) {
  const next = {};
  for (const [ip, until] of Object.entries(current)) if (until > now) next[ip] = until;
  for (const ip of offenders) next[ip] = Math.max(next[ip] ?? 0, now + blockSec);
  return Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max),
  );
}

function offenderQuery(maxRequests, maxErrors) {
  for (const v of [maxRequests, maxErrors]) {
    if (!Number.isInteger(Number(v)) || Number(v) < 1) throw new Error(`기준값은 1 이상 정수여야 한다: ${v}`);
  }
  return [
    'filter log = "access" and ispresent(ip) and ip != "127.0.0.1"',
    'stats count(*) as n, sum(s >= 400) as err by ip',
    `filter n >= ${Number(maxRequests)} or err >= ${Number(maxErrors)}`,
    'limit 200',
  ].join(' | ');
}

async function handler() {
  const logs = require('@aws-sdk/client-cloudwatch-logs');
  const cf = require('@aws-sdk/client-cloudfront');
  const env = process.env;
  const now = Math.floor(Date.now() / 1000);
  const lc = new logs.CloudWatchLogsClient({});
  const { queryId } = await lc.send(
    new logs.StartQueryCommand({
      logGroupName: env.LOG_GROUP,
      startTime: now - Number(env.WINDOW_MINUTES) * 60,
      endTime: now,
      queryString: offenderQuery(env.MAX_REQUESTS, env.MAX_ERRORS),
    }),
  );
  let res;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await lc.send(new logs.GetQueryResultsCommand({ queryId }));
    if (!['Scheduled', 'Running'].includes(res.status)) break;
  }
  if (res?.status !== 'Complete') throw new Error(`Logs Insights 질의 실패: ${res?.status}`);
  const rows = res.results.map((r) => Object.fromEntries(r.map((f) => [f.field, f.value])));
  const offenders = rows.map((r) => r.ip).filter(Boolean);

  const c = new cf.CloudFrontClient({ region: 'us-east-1' });
  const name = env.GUARD_FUNCTION;
  const desc = await c.send(new cf.DescribeFunctionCommand({ Name: name, Stage: 'DEVELOPMENT' }));
  const got = await c.send(new cf.GetFunctionCommand({ Name: name, Stage: 'DEVELOPMENT' }));
  const code = Buffer.from(got.FunctionCode).toString('utf8');
  const current = parseBlocked(code);
  let max = Number(env.MAX_ENTRIES);
  let next = nextBlocked(current, offenders, now, Number(env.BLOCK_HOURS) * 3600, max);
  while (Buffer.byteLength(writeBlocked(code, next)) > CODE_LIMIT && max > 0) {
    max = Math.floor(max * 0.8);
    next = nextBlocked(current, offenders, now, Number(env.BLOCK_HOURS) * 3600, max);
  }
  const added = Object.keys(next).filter((ip) => !(ip in current));
  const removed = Object.keys(current).filter((ip) => !(ip in next));
  const summary = { guard: 'checked', offenders: rows, blocked: Object.keys(next).length, added, removed };
  if (sortedJson(next) === sortedJson(current)) return console.log(JSON.stringify(summary));
  if (env.DRY_RUN === 'true') return console.log(JSON.stringify({ ...summary, guard: 'dry-run' }));

  const up = await c.send(
    new cf.UpdateFunctionCommand({
      Name: name,
      IfMatch: desc.ETag,
      FunctionConfig: desc.FunctionSummary.FunctionConfig,
      FunctionCode: Buffer.from(writeBlocked(code, next)),
    }),
  );
  await c.send(new cf.PublishFunctionCommand({ Name: name, IfMatch: up.ETag }));
  console.log(JSON.stringify({ ...summary, guard: 'published' }));
}

module.exports = { handler, parseBlocked, writeBlocked, nextBlocked, offenderQuery };
