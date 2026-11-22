#!/usr/bin/env node
/**
 * 版本号一致性检查（本地与 CI 都跑）
 *
 * 为什么需要它：sw.js 对静态资源是 cache-first 且按 URL 精确匹配，
 * 所以 index.html 与 sw.js 里的 `?v=` 必须和 version.json 完全一致。
 * 漏改一处 = 线上永远拿到旧文件（本地看着「改了没生效」），
 * 而这种错误单测和浏览器探针都抓不到 —— 它们读的是本地文件，不是缓存。
 *
 * 用法：node tools/check-version.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let fail = 0;
const bad = (msg) => {
  console.error('✗ ' + msg);
  fail += 1;
};

const v = JSON.parse(read('version.json')).v;
if (!v) bad('version.json 里没有 v 字段');
console.log('version.json v = ' + v);

/** 收集所有 ?v= 的值，返回出现次数；顺带报告与 version.json 不一致的值 */
function collect(src, file) {
  const all = [...src.matchAll(/\?v=([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  const wrong = [...new Set(all.filter((x) => x !== v))];
  if (wrong.length) bad(`${file} 里有与 version.json 不一致的 ?v= ：${wrong.join(', ')}`);
  return all.length;
}

const idx = read('index.html');
const sw = read('sw.js');
const nIdx = collect(idx, 'index.html');
const nSw = collect(sw, 'sw.js');

if (!nIdx) bad('index.html 里一个 ?v= 都没有（是不是忘了给资源加版本号？）');
if (!nSw) bad('sw.js 里一个 ?v= 都没有');

const meta = idx.match(/<meta name="app-version" content="([^"]+)"/);
if (!meta) bad('index.html 缺少 <meta name="app-version">');
else if (meta[1] !== v) bad(`index.html 的 app-version=${meta[1]}，与 version.json 的 ${v} 不一致`);

if (fail) {
  console.error(`\n共 ${fail} 处不一致。改 JS/CSS 必须同时改 index.html、sw.js、version.json 三处，否则线上还是旧版。`);
  process.exit(1);
}
console.log(`✓ 版本号一致：${v}（index.html ${nIdx} 处、sw.js ${nSw} 处）`);
