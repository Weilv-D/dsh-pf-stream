// 发布后验证：直查 registry 元数据，确认版本存在且 latest 指向该版本。
// 用法：node scripts/verify-release.mjs <version>
// 退出码：0=通过；1=观察窗口内未通过。
const version = process.argv[2];
if (!version) {
  console.error('用法：node scripts/verify-release.mjs <version>');
  process.exit(2);
}

const REGISTRY = 'https://registry.npmjs.org/dsh-pf-stream';
const ATTEMPTS = 30;
const INTERVAL_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMeta() {
  const res = await fetch(REGISTRY, { cache: 'no-store' });
  if (!res.ok) throw new Error(`registry 返回 HTTP ${res.status}`);
  return res.json();
}

let last = '尚未查询';
for (let i = 1; i <= ATTEMPTS; i++) {
  await sleep(INTERVAL_MS);
  try {
    const meta = await fetchMeta();
    const present = Boolean(meta.versions?.[version]);
    const latest = meta['dist-tags']?.latest ?? '(无)';
    const publishedAt = meta.time?.[version] ?? 'n/a';
    last = `version=${present} latest=${latest} published=${publishedAt}`;
    console.log(`第 ${i} 次查询：${last}`);
    if (present && latest === version) {
      console.log(`通过：dsh-pf-stream@${version} 已发布，latest 指向该版本。`);
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
