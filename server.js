/*!
 * PageAgent server — zero-dependency Node server.
 *
 *  • serves the static demo (index.html, pageagent.js)
 *  • exposes POST /api/plan which calls DeepSeek server-side so the
 *    DEEPSEEK_API_KEY never reaches the browser. It is injected via a
 *    fly secret (`flyctl secrets set DEEPSEEK_API_KEY=...`).
 *
 * Run:  node server.js    (PORT env, default 8080)
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const SYSTEM_PROMPT = [
  'You are PageAgent, an on-page AI agent.',
  'Given a user command and a JSON list of the page\'s interactive elements ({id,label,tag,type}),',
  'return ONLY a JSON array of steps to accomplish the command.',
  'Each step MUST be one of:',
  '{"action":"click","target":"<exact label or id>"}',
  '{"action":"type","target":"<label or id>","value":"<text>"}',
  '{"action":"select","target":"<label or id>","value":"<option>"}',
  '{"action":"scroll","target":"<label|top|bottom>"}',
  '{"action":"wait","ms":500}',
  'Use the exact element labels from the list. For navigation, prefer clicking the relevant nav element.',
  'Respond with JSON only — no markdown fences, no prose.',
].join(' ');

function callDeepSeek(command, elements) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Command: ${command}\nElements: ${JSON.stringify(elements)}` },
      ],
    });
    const url = new URL(DEEPSEEK_URL);
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const j = JSON.parse(data);
            resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
          } catch (e) { reject(new Error('DeepSeek returned non-JSON')); }
        } else {
          reject(new Error(`DeepSeek ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(s));
  });
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function serveStatic(urlPath, res) {
  let p = decodeURIComponent((urlPath.split('?')[0] || '/'));
  if (p === '/' || p === '') p = '/index.html';
  const safe = path.normalize(p).replace(/^([.]{2,}[\\/])+/, '');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/plan') {
    if (!DEEPSEEK_KEY) return sendJSON(res, 500, { error: 'DEEPSEEK_API_KEY not set on server' });
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      if (!payload.command) return sendJSON(res, 400, { error: 'command required' });
      const text = await callDeepSeek(payload.command, Array.isArray(payload.elements) ? payload.elements : []);
      const match = text.match(/\[[\s\S]*\]/);
      let steps = [];
      if (match) { try { steps = JSON.parse(match[0]); } catch { steps = []; } }
      console.log(`[plan] ${String(payload.command).slice(0, 60)} -> ${steps.length} steps`);
      return sendJSON(res, 200, { steps, model: DEEPSEEK_MODEL });
    } catch (e) {
      console.error('[plan] error:', e.message);
      return sendJSON(res, 502, { error: 'planning failed', detail: String(e.message || e) });
    }
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJSON(res, 200, { ok: true, deepseek: !!DEEPSEEK_KEY, model: DEEPSEEK_MODEL });
  }
  return serveStatic(req.url, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PageAgent listening on :${PORT}  (DeepSeek ${DEEPSEEK_KEY ? 'ON' : 'OFF — set DEEPSEEK_API_KEY'})`);
});
