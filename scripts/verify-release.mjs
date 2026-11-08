// 发布后验证：直查 registry 元数据，确认版本存在且 latest 已到达/超过该版本。
// 用法：node scripts/verify-release.mjs <version>
// 退出码：0=通过；1=观察窗口内未通过。
const version = process.argv[2];
if (!version) {
  console.error('用法：node scripts/verify-release.mjs <version>');
  process.exit(2);
}

const REGISTRY = 'https://registry.npmjs.org/dsh-pf-stream';
const ATTEMPTS = 43;
// 分级轮询：正常传播 1-2 分钟内即通过；0.3.4 实测 Trusted Publishing 下传播
// 可超 5 分钟，5 分钟窗口曾误报失败（发布规范 §9），故放宽到 15 分钟。
// SOFT_DEADLINE_MS 为进程级软截止：43 次全部 5s 超时的病态场景下总耗时
// 会逼近 publish job 的 20 分钟上限，宁可提前干净失败（可 rerun）也不要被
// job timeout 强杀（排障时无法区分两类失败）。
const SOFT_DEADLINE_MS = 14 * 60_000;
function intervalFor(i) {
  if (i <= 12) return 10_000;
  if (i <= 27) return 20_000;
  return 30_000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMeta() {
  // 单次请求必须有上限：挂死的 TCP 连接不能拖到 job 级 timeout 才收口。
  const res = await fetch(REGISTRY, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`registry 返回 HTTP ${res.status}`);
  return res.json();
}

/** latest 是否已到达/超过目标版本（并发发布更高版本时不应误报失败）。
 * latest 为 prerelease 等非正式版本号时按「不高于」放行并告警——本脚本的
 * 使命是「不误报已成功的发布」，正式性由 publish 守卫与发布规范保证。 */
function isAtLeast(latest, target) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match ? match.slice(1).map(Number) : undefined;
  };
  const a = parse(latest);
  const b = parse(target);
  if (b === undefined) return latest === target;
  if (a === undefined) {
    console.log(`警告：dist-tags.latest=${latest} 非正式版本号，按不高于目标处理`);
    return true;
  }
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
}

let last = '尚未查询';
const startedAt = Date.now();
for (let i = 1; i <= ATTEMPTS; i++) {
  if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
    console.error(`::error::已达 ${Math.round(SOFT_DEADLINE_MS / 60_000)} 分钟软截止，停止轮询`);
    break;
  }
  await sleep(intervalFor(i));
  try {
    const meta = await fetchMeta();
    const present = Boolean(meta.versions?.[version]);
    const latest = meta['dist-tags']?.latest ?? '(无)';
    const latestOk = latest !== '(无)' && isAtLeast(latest, version);
    const publishedAt = meta.time?.[version] ?? 'n/a';
    last = `version=${present} latest=${latest} latestOk=${latestOk} published=${publishedAt}`;
    console.log(`第 ${i} 次查询：${last}`);
    if (present && latestOk) {
      console.log(`通过：dsh-pf-stream@${version} 已发布，latest 已到达该版本。`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`第 ${i} 次查询异常：${e.message}`);
  }
}

console.error(
  `::error::观察窗口内未在 registry 检出 dsh-pf-stream@${version}（最后状态：${last}）`,
);
process.exit(1);
