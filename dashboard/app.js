'use strict';
const $ = (id) => document.getElementById(id);
const runs = new Map();
let submitting = false;
let stream;

function updateButtons() {
  const active = [...runs.values()].some(run => run.status === 'running');
  $('run-button').disabled = active || submitting;
  $('run-label').textContent = submitting ? 'Starting…' : active ? 'Runner active…' : 'Run';
  $('clear-button').disabled = ![...runs.values()].some(run => run.endedAt);
  $('run-count').textContent = String(runs.size);
  $('empty').hidden = runs.size > 0;
}

function renderLog(entry) {
  const row = document.createElement('span');
  row.className = 'console-line' + (entry.text.startsWith('[ERR]') ? ' error' : '');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(entry.at).toLocaleTimeString();
  row.append(time, document.createTextNode(entry.text)); // Never inject console HTML.
  return row;
}

function drawRuns() {
  const list = $('runs');
  list.replaceChildren();
  const sorted = [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const run of sorted) {
    const article = document.createElement('article');
    article.className = 'run';
    article.dataset.id = run.id;
    const top = document.createElement('div');
    top.className = 'run-top';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'run-title';
    title.textContent = 'Quest runner ' + run.id.slice(0, 8);
    const status = document.createElement('span');
    status.className = 'status ' + run.status;
    status.textContent = run.status;
    title.append(status);
    const meta = document.createElement('div');
    meta.className = 'run-meta';
    meta.textContent = 'Started ' + new Date(run.startedAt).toLocaleString();
    left.append(title, meta);
    top.append(left);
    if (run.status === 'running') {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'stop';
      stop.textContent = 'Stop';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try { await request('/api/runs/' + run.id + '/stop', { method: 'POST' }); }
        catch (err) { showError(err.message); stop.disabled = false; }
      });
      top.append(stop);
    }
    const head = document.createElement('div');
    head.className = 'console-head';
    const label = document.createElement('span');
    label.textContent = '● LIVE CONSOLE';
    const count = document.createElement('span');
    count.textContent = run.logs.length + ' lines';
    head.append(label, count);
    const consoleArea = document.createElement('pre');
    consoleArea.className = 'console';
    consoleArea.setAttribute('aria-label', 'Runner console');
    for (const entry of run.logs) consoleArea.append(renderLog(entry));
    if (!run.logs.length) consoleArea.textContent = 'Waiting for output…';
    article.append(top, head, consoleArea);
    list.append(article);
    consoleArea.scrollTop = consoleArea.scrollHeight;
  }
  updateButtons();
}

function showError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
}
function clearError() { $('form-error').hidden = true; $('form-error').textContent = ''; }

async function request(route, options) {
  const response = await fetch(route, { cache:'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

function connect() {
  if (stream) stream.close();
  stream = new EventSource('/api/events');
  stream.addEventListener('open', () => {
    $('connection').classList.add('online');
    $('connection-label').textContent = 'Console connected';
  });
  stream.addEventListener('error', () => {
    $('connection').classList.remove('online');
    $('connection-label').textContent = 'Reconnecting…';
  });
  stream.addEventListener('snapshot', ({data}) => {
    runs.clear();
    for (const run of JSON.parse(data).runs) runs.set(run.id, run);
    drawRuns();
  });
  stream.addEventListener('run', ({data}) => {
    const run = JSON.parse(data);
    const existing = runs.get(run.id);
    if (existing && existing.logs.length > run.logs.length) run.logs = existing.logs;
    runs.set(run.id, run);
    drawRuns();
  });
  stream.addEventListener('log', ({data}) => {
    const {id, entry} = JSON.parse(data);
    const run = runs.get(id);
    if (!run) return;
    run.logs.push(entry);
    if (run.logs.length > 350) run.logs.shift();
    const article = [...document.querySelectorAll('.run')].find(item => item.dataset.id === id);
    if (!article) return drawRuns();
    const area = article.querySelector('.console');
    if (area.textContent === 'Waiting for output…') area.replaceChildren();
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 65;
    area.append(renderLog(entry));
    while (area.children.length > 350) area.firstChild.remove();
    article.querySelector('.console-head span:last-child').textContent = run.logs.length + ' lines';
    if (nearBottom) area.scrollTop = area.scrollHeight;
  });
}

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  clearError();
  const token = $('token').value.trim();
  submitting = true;
  updateButtons();
  try {
    const {run} = await request('/api/run', {
      method:'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({token}),
    });
    $('token').value = ''; // Clear the form immediately after starting.
    $('token').type = 'password';
    $('reveal').textContent = 'Show';
    runs.set(run.id, run);
    drawRuns();
  } catch (err) { showError(err.message); }
  finally { submitting = false; updateButtons(); }
});
$('reveal').addEventListener('click', () => {
  const visible = $('token').type === 'password';
  $('token').type = visible ? 'text' : 'password';
  $('reveal').textContent = visible ? 'Hide' : 'Show';
  $('reveal').setAttribute('aria-label', visible ? 'Hide token' : 'Show token');
});
$('clear-button').addEventListener('click', async () => {
  clearError();
  try { await request('/api/runs/finished', {method:'DELETE'}); }
  catch (err) { showError(err.message); }
});
connect();
