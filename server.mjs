// pc-bridge —— 手机（Kelivo）通过局域网操控这台电脑
// 传输：Streamable HTTP（MCP 2025-03-26），无状态，适合手机上点点就走
// 安全：所有 /mcp 请求必须带 Authorization: Bearer <BRIDGE_TOKEN>
// 文件：只允许 BRIDGE_ROOT 内的路径；静态预览带 ?t=token
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN = process.env.BRIDGE_TOKEN || '';
const ROOT = path.resolve(process.env.BRIDGE_ROOT || 'D:\\anim');
const TIMEOUT_MS = Number(process.env.BRIDGE_CMD_TIMEOUT || 600000);

if (!TOKEN || TOKEN.length < 16) {
  console.error('缺少 BRIDGE_TOKEN（至少 16 位）。生成方法：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}
fsSync.mkdirSync(ROOT, { recursive: true });

// ── 路径安全 ─────────────────────────────────────────────
function safePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('路径为空');
  const abs = path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('越界：只能访问 ' + ROOT);
  return abs;
}
function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}
function run(cmd, cwd, timeout) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = exec(cmd, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: 'cmd.exe' }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      const cut = s => (typeof s === 'string' && s.length > 60000 ? s.slice(0, 40000) + '\n…[已截断]…\n' + s.slice(-15000) : s || '');
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        timedOut: !!(err && err.killed),
        ms,
        stdout: cut(stdout),
        stderr: cut(stderr),
      });
    });
    child.on('error', e => resolve({ code: -1, timedOut: false, ms: 0, stdout: '', stderr: String(e) }));
  });
}

// ── MCP 工具集 ───────────────────────────────────────────
function buildServer() {
  const s = new McpServer({ name: 'pc-bridge', version: '1.0.0' });

  s.tool(
    'run_command',
    '在这台 Windows 电脑上执行命令（cmd.exe）。用来装依赖、跑 npm/node/python、调 ffmpeg、git 等。' +
    'cwd 相对于 ' + ROOT + '，默认就是它。超时默认 10 分钟。返回退出码、耗时、stdout/stderr。',
    {
      command: z.string().describe('完整命令行，例如 npm run build'),
      cwd: z.string().optional().describe('工作目录（相对 ' + ROOT + '）'),
      timeout_ms: z.number().int().min(1000).max(3600000).optional().describe('超时毫秒，默认 600000'),
    },
    async ({ command, cwd, timeout_ms }) => {
      const dir = safePath(cwd || '.');
      const st = fsSync.existsSync(dir) ? fsSync.statSync(dir) : null;
      if (!st || !st.isDirectory()) throw new Error('目录不存在：' + dir);
      const r = await run(command, dir, timeout_ms || TIMEOUT_MS);
      const body = [
        `$ ${command}`,
        `cwd: ${dir}`,
        `exit: ${r.code}${r.timedOut ? ' (超时被杀)' : ''}  用时 ${(r.ms / 1000).toFixed(1)}s`,
        r.stdout ? '\n--- stdout ---\n' + r.stdout : '',
        r.stderr ? '\n--- stderr ---\n' + r.stderr : '',
      ].join('\n');
      return { content: [{ type: 'text', text: body.slice(0, 100000) }], isError: r.code !== 0 };
    }
  );

  s.tool(
    'read_file',
    '读取文本文件。可选 offset/limit 按行取一段，避免读大文件。',
    {
      path: z.string().describe('相对 ' + ROOT + ' 的路径'),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      encoding: z.enum(['utf8', 'base64']).optional(),
    },
    async ({ path: p, offset, limit, encoding }) => {
      const abs = safePath(p);
      const st = await fs.stat(abs);
      if (st.size > 40 * 1024 * 1024) throw new Error('文件过大（>40MB），请用 run_command 分块读');
      if (encoding === 'base64') {
        const b = await fs.readFile(abs);
        return { content: [{ type: 'text', text: b.toString('base64') }] };
      }
      const text = await fs.readFile(abs, 'utf8');
      if (!offset && !limit) return { content: [{ type: 'text', text: text.slice(0, 120000) }] };
      const lines = text.split(/\r?\n/);
      const from = (offset || 1) - 1;
      const slice = lines.slice(from, from + (limit || 400));
      return { content: [{ type: 'text', text: slice.map((l, i) => `${from + i + 1}\t${l}`).join('\n') }] };
    }
  );

  s.tool(
    'write_file',
    '写文本文件（覆盖）。父目录不存在会自动创建。用于改代码、写配置。',
    {
      path: z.string().describe('相对 ' + ROOT + ' 的路径'),
      content: z.string().describe('完整文件内容'),
    },
    async ({ path: p, content }) => {
      const abs = safePath(p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      const st = await fs.stat(abs);
      return { content: [{ type: 'text', text: `已写入 ${abs}（${st.size} 字节）` }] };
    }
  );

  s.tool(
    'list_dir',
    '列目录。返回名字、类型、大小、修改时间。',
    {
      path: z.string().optional().describe('相对 ' + ROOT + ' 的路径，默认根目录'),
      depth: z.number().int().min(1).max(3).optional().describe('递归深度，默认 1'),
    },
    async ({ path: p, depth }) => {
      const abs = safePath(p || '.');
      const walk = async (dir, d) => {
        const ents = await fs.readdir(dir, { withFileTypes: true });
        ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
        const out = [];
        for (const e of ents) {
          const full = path.join(dir, e.name);
          const rel = path.relative(ROOT, full).replace(/\\/g, '/');
          let size = 0, mtime = '';
          try { const s2 = await fs.stat(full); size = s2.size; mtime = s2.mtime.toISOString().slice(0, 16).replace('T', ' '); } catch {}
          out.push(`${e.isDirectory() ? 'd' : '-'} ${(size / 1024).toFixed(0).padStart(8)}K  ${mtime}  ${rel}${e.isDirectory() ? '/' : ''}`);
          if (e.isDirectory() && d > 1 && out.length < 400) out.push(...(await walk(full, d - 1)));
        }
        return out;
      };
      const lines = await walk(abs, depth || 1);
      return { content: [{ type: 'text', text: `根目录：${ROOT}\n` + lines.slice(0, 600).join('\n') }] };
    }
  );

  s.tool(
    'preview_url',
    '把电脑上的一个文件（视频/图片/HTML）变成手机可直接打开的链接。返回 LAN 地址，手机浏览器或 Kelivo 打开即看。',
    { path: z.string().describe('相对 ' + ROOT + ' 的路径') },
    async ({ path: p }) => {
      const abs = safePath(p);
      if (!fsSync.existsSync(abs)) throw new Error('文件不存在：' + abs);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      const ips = lanIPs();
      const host = ips[0] ? ips[0].ip : '127.0.0.1';
      const url = `http://${host}:${PORT}/files/${rel.split('/').map(encodeURIComponent).join('/')}?t=${TOKEN}`;
      const st = await fs.stat(abs);
      return {
        content: [{
          type: 'text',
          text: `[打开 ${rel}（${(st.size / 1024 / 1024).toFixed(2)} MB）](${url})\n\n` +
                (ips.length > 1 ? '其它网卡：' + ips.map(i => `${i.ip} (${i.name})`).join(', ') : ''),
        }],
      };
    }
  );

  s.tool(
    'system_info',
    '报这台机器的情况：系统、CPU、内存、磁盘剩余、Node/ffmpeg 是否可用、当前 LAN 地址。排障第一步。',
    {},
    async () => {
      const info = {
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        host: os.hostname(),
        cpu: os.cpus()[0]?.model || '?',
        cores: os.cpus().length,
        memGB: (os.totalmem() / 1e9).toFixed(1),
        freeMemGB: (os.freemem() / 1e9).toFixed(1),
        root: ROOT,
        port: PORT,
        lan: lanIPs(),
      };
      const probe = await Promise.all([
        run('node -v', ROOT, 8000),
        run('ffmpeg -version', ROOT, 8000),
        run('git --version', ROOT, 8000),
      ]);
      const txt = [
        `${info.platform}  主机 ${info.host}`,
        `CPU ${info.cpu} × ${info.cores}`,
        `内存 ${info.freeMemGB} / ${info.memGB} GB 可用`,
        `工作根目录 ${info.root}`,
        `LAN ${info.lan.map(i => `${i.ip} (${i.name})`).join(' | ') || '无'}`,
        `node   ${probe[0].code === 0 ? probe[0].stdout.trim().split('\n')[0] : '不可用'}`,
        `ffmpeg ${probe[1].code === 0 ? probe[1].stdout.trim().split('\n')[0] : '不可用'}`,
        `git    ${probe[2].code === 0 ? probe[2].stdout.trim() : '不可用'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: txt }] };
    }
  );

  return s;
}

// ── HTTP 层 ──────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));

function authOK(req) {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) {
    const got = Buffer.from(h.slice(7));
    const want = Buffer.from(TOKEN);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  // 浏览器打开静态文件时用 ?t=
  const q = req.query && typeof req.query.t === 'string' ? req.query.t : '';
  return q.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(q), Buffer.from(TOKEN));
}

app.get('/health', (_req, res) => res.json({ ok: true, root: ROOT, lan: lanIPs(), port: PORT }));

// MCP：无状态，每个 POST 建一个 server+transport，响应结束即销毁
app.post('/mcp', async (req, res) => {
  if (!authOK(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null });
  }
});

// 无状态模式不提供服务端推送
app.get('/mcp', (req, res) => res.status(405).json({ error: 'Use POST /mcp' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'stateless' }));

// 静态文件预览（带 Range，视频可拖动）
app.get('/files/*', async (req, res) => {
  if (!authOK(req)) { res.status(401).send('unauthorized'); return; }
  let rel;
  try { rel = decodeURIComponent(req.params[0] || ''); } catch { res.status(400).send('bad path'); return; }
  let abs;
  try { abs = safePath(rel); } catch (e) { res.status(403).send(String(e)); return; }
  let st;
  try { st = await fs.stat(abs); } catch { res.status(404).send('not found'); return; }
  if (st.isDirectory()) { res.status(400).send('is a directory'); return; }
  const type = contentType(abs);
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end(); return; }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fsSync.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', st.size);
  fsSync.createReadStream(abs).pipe(res);
});

function contentType(f) {
  const e = path.extname(f).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  })[e] || 'application/octet-stream';
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('pc-bridge 已启动');
  console.log('  根目录 ' + ROOT);
  console.log('  端口   ' + PORT);
  const ips = lanIPs();
  ips.forEach(i => console.log(`  手机填 http://${i.ip}:${PORT}/mcp   (${i.name})`));
  if (!ips.length) console.log('  没有找到局域网地址，确认电脑已连上手机热点');
});
