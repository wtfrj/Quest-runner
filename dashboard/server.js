'use strict';

// Local-only dashboard. Tokens are passed to the worker through its environment;
// they are never written to disk or returned to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = '127.0.0.1'; // Do not expose the token form on a public interface.
const CLIENT = path.join(__dirname, 'index.html');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runs = new Map();
const listeners = new Set();
let activeId = null;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('DASHBOARD_PORT must be a valid TCP port (1-65535).');
  process.exit(1);
}

function writeJson(res, status, object) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(object));
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    logs: run.logs,
  };
}

function sendEvent(res, type, object) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(object)}\n\n`);
}

function notify(type, object) {
  for (const res of [...listeners]) {
    try { sendEvent(res, type, object); }
    catch { listeners.delete(res); }
  }
}

function appendLog(run, message) {
  // Remove terminal control sequences and scrub tokens if a dependency prints them.
  let line = String(message).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (run.redact) line = line.split(run.redact).join('[REDACTED TOKEN]');
  if (line.length > 1800) line = `${line.slice(0, 1800)}… [line truncated]`;
  const entry = { at: new Date().toISOString(), text: line };
  run.logs.push(entry);
  if (run.logs.length > 350) run.logs.shift();
  notify('log', { id: run.id, entry });
}

function connectOutput(child, stream, run, name) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    // Avoid unbounded memory use on a process that prints no newlines.
    if (pending.length > 12000) {
      appendLog(run, `[${name}] ${pending.slice(0, 11000)}… [output truncated]`);
      pending = '';
    }
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      appendLog(run, `[${name}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (pending) appendLog(run, `[${name}] ${pending}`);
  });
}

function finish(run, status, code) {
  if (run.endedAt) return;
  run.status = status;
  run.exitCode = code;
  run.endedAt = new Date().toISOString();
  run.child = null;
  run.redact = null;
  if (activeId === run.id) activeId = null;
  appendLog(run, status === 'finished'
    ? 'Runner exited normally. Check the logs to confirm individual quest results.'
    : status === 'stopped'
      ? 'Runner stopped.'
      : `Runner exited with ${code === null ? 'no exit code' : `code ${code}`}. Check the errors above.`);
  notify('run', publicRun(run));
}

function startRun(token) {
  if (!fs.existsSync(TSX)) throw new Error('Dependencies missing. Run npm install first.');
  const id = randomUUID();
  const run = {
    id, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
    exitCode: null, logs: [], child: null, redact: token, stopRequested: false,
  };
  runs.set(id, run);
  activeId = id;
  notify('run', publicRun(run));
  appendLog(run, 'Starting quest runner…');
  const child = spawn(process.execPath, [TSX, 'bot.ts'], {
    cwd: ROOT,
    env: { ...process.env, TOKEN: token },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;
  connectOutput(child, child.stdout, run, 'OUT');
  connectOutput(child, child.stderr, run, 'ERR');
  child.on('error', (err) => {
    appendLog(run, `Could not start runner: ${err.message}`);
    finish(run, 'failed', null);
  });
  child.on('close', (code, signal) => {
    const status = run.stopRequested ? 'stopped' : (code === 0 ? 'finished' : 'failed');
    if (signal) appendLog(run, `Runner ended with signal ${signal}.`);
    finish(run, status, code);
  });
  // Show only the eight most recent runs, retaining the active one.
  while (runs.size > 8) {
    const oldest = [...runs.values()].find(r => r.id !== activeId && r.endedAt);
    if (!oldest) break;
    runs.delete(oldest.id);
  }
  return publicRun(run);
}

function sameOrigin(req) {
  const host = req.headers.host || '';
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!allowed.has(host)) return false; // Stops DNS rebinding against localhost.
  const origin = req.headers.origin;
  if (origin && !allowed.has(new URL(origin).host)) return false;
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) { reject(new Error('Request is too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Expected valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Host and Origin checks also apply to the event stream and all mutating routes.
  if (!sameOrigin(req)) return writeJson(res, 403, { error: 'Open the dashboard at http://127.0.0.1:' + PORT });
  const route = (req.url || '').split('?')[0];
  if (req.method === 'GET' && route === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    return fs.createReadStream(CLIENT).pipe(res);
  }
  if (req.method === 'GET' && route === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(__dirname, 'app.js')).pipe(res);
  }
  if (req.method === 'GET' && route === '/styles.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(__dirname, 'styles.css')).pipe(res);
  }
  if (req.method === 'GET' && route === '/api/runs') {
    return writeJson(res, 200, { runs: [...runs.values()].reverse().map(publicRun), running: Boolean(activeId) });
  }
  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    listeners.add(res);
    sendEvent(res, 'snapshot', { runs: [...runs.values()].reverse().map(publicRun) });
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); listeners.delete(res); }
    }, 20000);
    req.on('close', () => { clearInterval(heartbeat); listeners.delete(res); });
    return;
  }
  if (req.method === 'POST' && route === '/api/run') {
    if (activeId) return writeJson(res, 409, { error: 'A runner is already active. Wait for it to finish or stop it.' });
    let body;
    try { body = await parseBody(req); }
    catch (err) { return writeJson(res, 400, { error: err.message }); }
    const token = body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 500 || /\s|[\x00-\x1f\x7f]/.test(token)) {
      return writeJson(res, 400, { error: 'Enter a valid token without spaces or line breaks.' });
    }
    try { return writeJson(res, 202, { run: startRun(token) }); }
    catch (err) { return writeJson(res, 500, { error: err.message }); }
  }
  const stopMatch = route.match(/^\/api\/runs\/([a-f0-9-]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const run = runs.get(stopMatch[1]);
    if (!run || !run.child || run.endedAt) return writeJson(res, 404, { error: 'No running process with this ID.' });
    run.stopRequested = true;
    appendLog(run, 'Stop requested…');
    try { run.child.kill(); }
    catch (err) { return writeJson(res, 500, { error: `Could not stop runner: ${err.message}` }); }
    return writeJson(res, 202, { ok: true });
  }
  if (req.method === 'DELETE' && route === '/api/runs/finished') {
    for (const [id, run] of runs) if (run.endedAt) runs.delete(id);
    notify('snapshot', { runs: [...runs.values()].reverse().map(publicRun) });
    return writeJson(res, 200, { ok: true });
  }
  return writeJson(res, 404, { error: 'Not found.' });
});

server.on('error', (error) => {
  console.error(`Cannot start dashboard: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log(`Dashboard ready: http://${HOST}:${PORT}`);
  console.log('Local-only. Never expose this token dashboard directly to the public internet.');
});
