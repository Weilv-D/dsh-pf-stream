// 伪本地 ASR CLI：验证 local_cli 的令牌展开与产物回读
// 用法：node fake-asr-cli.mjs <mode> [args...]
//  mode=dir-srt  --dir <目录>     写 <目录>\chunk.srt 并向 stdout 打印进度杂讯
//  mode=out-json --out <文件>     写 JSON 到指定文件
//  mode=stdout   --audio <路径>   向 stdout 打印 SRT
const mode = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const { writeFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
if (mode === 'dir-srt') {
  const dir = arg('--dir');
  writeFileSync(join(dir, 'chunk.srt'), '1\n00:00:00,500 --> 00:00:02,000\n你好世界\n', 'utf8');
  console.log("Detected language 'Chinese' with probability 1.000000");
  console.log(`Transcription results written to '${dir}' directory`);
} else if (mode === 'out-json') {
  const out = arg('--out');
  writeFileSync(out, JSON.stringify({ segments: [{ start: 0.25, end: 1.5, text: '令牌输出' }] }), 'utf8');
  console.log('chatter on stdout');
} else if (mode === 'stdout') {
  console.log('1\n00:00:01,000 --> 00:00:02,500\n标准输出台词\n');
} else if (mode === 'audio-bytes') {
  const audio = arg('--audio');
  if (!audio) process.exit(3);
  const buf = await import('node:fs').then((fs) => fs.readFileSync(audio));
  console.log(`1\n00:00:00,000 --> 00:00:01,000\nbytes=${buf.length}`);
}
