#!/usr/bin/env node
/**
 * 官网静态服务（开发用）—— 项目交接文档 §4.4 口径：
 *   node apps/site/static-serve.cjs 5181        # http://localhost:5181
 *
 * 特性：
 *   - 目录式 URL：/apply/ -> apply/index.html（历史 20 项冒烟依赖该行为）
 *   - 无缓存响应头：避免 Chrome 启发式缓存导致改完 CSS/JS 复测拿到旧码
 *     （AGENTS.md：静态站 JS/CSS 修改必须防启发式缓存）
 *   - 路径穿越保护：只允许落在 apps/site 内
 *
 * 注意：扩展名是 .cjs（文档既定命令），因此必须用 CommonJS require，不能用 import。
 */
'use strict';

const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve, sep } = require('node:path');

const ROOT = resolve(__dirname);
const PORT = Number(process.argv[2] || 5181);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  if (rel.indexOf('\0') !== -1) return null;
  const target = normalize(join(ROOT, rel));
  if (target !== ROOT && target.indexOf(ROOT + sep) !== 0) return null;

  if (existsSync(target) && statSync(target).isFile()) return target;
  const asIndex = join(target, 'index.html');
  if (existsSync(asIndex) && statSync(asIndex).isFile()) return asIndex;
  return null;
}

const server = createServer((req, res) => {
  const file = resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`官网静态服务已启动：http://localhost:${PORT}（根目录 ${ROOT}）`);
});
