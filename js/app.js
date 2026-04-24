import { WebR } from 'https://webr.r-wasm.org/latest/webr.mjs';

// ─── State ────────────────────────────────────────────────────
const state = {
  webR: null,
  webrReady: false,
  questions: [],
  currentQuestion: null,
  currentCourse: 'R',
  editor: null,
  completedIds: new Set(JSON.parse(localStorage.getItem('completedIds') || '[]')),
};

const CLIENT_ID = (() => {
  let id = localStorage.getItem('client_id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('client_id', id); }
  return id;
})();

const $ = id => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  applyTheme(localStorage.getItem('theme') || 'dark');

  const authed = sessionStorage.getItem('auth') === '1';
  if (authed) {
    showApp();
    startWebR();
  } else {
    $('pwd-modal').classList.remove('hidden');
  }

  $('pwd-form').addEventListener('submit', onPasswordSubmit);
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('run-btn').addEventListener('click', runCode);
  $('clear-btn').addEventListener('click', () => { state.editor?.setValue(''); state.editor?.focus(); });
  $('clear-console-btn').addEventListener('click', clearConsole);
  $('show-solution-btn').addEventListener('click', toggleSolution);
  $('copy-solution-btn').addEventListener('click', copySolution);
  $('hamburger').addEventListener('click', toggleSidebar);
  $('sidebar-overlay').addEventListener('click', closeSidebar);
  document.querySelectorAll('.course-tab').forEach(t =>
    t.addEventListener('click', () => switchCourse(t.dataset.course))
  );

  await loadQuestions();
}

// ─── Theme ────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const moon = document.querySelector('.icon-moon');
  const sun  = document.querySelector('.icon-sun');
  if (theme === 'dark') { moon?.classList.remove('hidden'); sun?.classList.add('hidden'); }
  else                  { moon?.classList.add('hidden');    sun?.classList.remove('hidden'); }
  if (state.editor) state.editor.setOption('theme', theme === 'dark' ? 'dracula' : 'eclipse');
  document.querySelectorAll('.sol-cm').forEach(cm => cm.CodeMirror?.setOption('theme', theme === 'dark' ? 'dracula' : 'eclipse'));
}

function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

// ─── Password ─────────────────────────────────────────────────
async function onPasswordSubmit(e) {
  e.preventDefault();
  const input = $('pwd-input').value.trim();
  if (!input) return;
  if (await checkPassword(input)) {
    sessionStorage.setItem('auth', '1');
    $('pwd-modal').classList.add('hidden');
    showApp();
    startWebR();
  } else {
    $('pwd-error').textContent = 'Incorrect password — please try again.';
    $('pwd-input').value = '';
    $('pwd-input').focus();
  }
}

async function checkPassword(input) {
  try {
    const resp = await fetch('./data/password.json');
    const { hash } = await resp.json();
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const hex  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    return hex === hash;
  } catch { return false; }
}

// ─── App Display ──────────────────────────────────────────────
function showApp() {
  $('app').classList.remove('hidden');
  initEditor();
}

// ─── WebR ─────────────────────────────────────────────────────
async function startWebR() {
  const screen = $('loading-screen');
  screen.classList.remove('hidden');
  setStatus('loading', 'Loading R...');

  try {
    state.webR = new WebR();
    await state.webR.init();

    state.webrReady = true;
    screen.classList.add('hidden');
    setStatus('ready', 'R Ready');
    $('run-btn').disabled = false;
  } catch (err) {
    $('load-status').textContent = `Init error: ${err.message}`;
    setStatus('error', 'R Error');
    setTimeout(() => screen.classList.add('hidden'), 3000);
  }
}

function setStatus(type, text) {
  const dot  = $('webrStatus').querySelector('.status-dot');
  const span = $('webrStatus').querySelector('.status-text');
  dot.className  = `status-dot ${type}`;
  span.textContent = text;
}

// ─── Editor ───────────────────────────────────────────────────
function initEditor() {
  if (state.editor) return;
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dracula' : 'eclipse';
  state.editor = CodeMirror($('editor-container'), {
    mode: 'r', theme,
    lineNumbers: true,
    indentUnit: 2, tabSize: 2, indentWithTabs: false,
    lineWrapping: true,
    matchBrackets: true,
    value: '# Write your R code here\n',
    extraKeys: { 'Ctrl-Enter': runCode, 'Cmd-Enter': runCode },
  });
  state.editor.setSize('100%', 220);
}

// ─── Questions ────────────────────────────────────────────────
async function loadQuestions() {
  try {
    const resp = await fetch('./data/questions.json');
    state.questions = await resp.json();
    renderSidebar();
  } catch (err) {
    console.error('Failed to load questions:', err);
  }
}

function renderSidebar() {
  const el      = $('sidebar-content');
  const list    = state.questions.filter(q => q.type === state.currentCourse);
  const weeks   = [...new Set(list.map(q => q.week))].sort((a, b) => a - b);

  el.innerHTML = weeks.map(w => {
    const qs = list.filter(q => q.week === w);
    const doneCount = qs.filter(q => state.completedIds.has(q.id)).length;
    return `
      <div class="sidebar-week">
        <div class="week-header">
          <span class="week-header-label">Week ${w}</span>
          <span class="week-header-line"></span>
          <span class="week-header-count">${doneCount}/${qs.length}</span>
        </div>
        <ul class="q-list">
          ${qs.map(q => {
            const locked  = isLocked(q);
            const active  = state.currentQuestion?.id === q.id;
            const done    = state.completedIds.has(q.id);
            const qNum    = q.id > 100 ? `E${q.id - 100}` : String(q.id);
            let statusHtml = '';
            if (locked) statusHtml = '<span class="q-status locked">🔒</span>';
            else if (done) statusHtml = '<span class="q-status done">✓</span>';
            return `
              <li class="q-item ${active ? 'active' : ''} ${locked ? 'locked-item' : ''} ${done && !active ? 'done' : ''}"
                  data-id="${q.id}" tabindex="${locked ? -1 : 0}" role="button">
                <span class="q-num-badge">${qNum}</span>
                <span class="q-item-title">${q.title}</span>
                ${statusHtml}
              </li>`;
          }).join('')}
        </ul>
      </div>`;
  }).join('');

  el.querySelectorAll('.q-item:not(.locked-item)').forEach(item => {
    const select = () => selectQuestion(parseInt(item.dataset.id));
    item.addEventListener('click', select);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') select(); });
  });
}

function isLocked(q) { return new Date() < new Date(q.release_at); }

function selectQuestion(id) {
  const q = state.questions.find(x => x.id === id);
  if (!q) return;
  state.currentQuestion = q;
  renderSidebar();
  renderQuestion(q);
  if (window.innerWidth < 768) closeSidebar();
}

function renderQuestion(q) {
  $('welcome-state').classList.add('hidden');
  $('question-view').classList.remove('hidden');

  $('q-badge').textContent    = `W${q.week} · Q${q.id}`;
  const typeBadge = $('q-type');
  typeBadge.textContent       = q.type;
  typeBadge.className         = `q-type-badge ${q.type === 'R' ? 'r-type' : 'excel-type'}`;
  $('q-title').textContent    = q.title;
  $('q-scenario').innerHTML   = q.scenario || '';
  $('q-task').innerHTML       = q.task;

  state.editor?.setValue(q.starter || '# Write your code here\n');
  clearConsole();

  const solPanel = $('solution-panel');
  solPanel.classList.add('hidden');
  $('solution-code').innerHTML = '';

  const locked = isLocked(q);
  const btn    = $('show-solution-btn');
  btn.classList.toggle('locked', locked);
  if (locked) {
    const d = new Date(q.release_at);
    $('solution-btn-text').textContent = `Unlocks ${d.toLocaleDateString('en-NZ', { weekday:'short', month:'short', day:'numeric' })}`;
  } else {
    $('solution-btn-text').textContent = 'Show Solution';
  }

  // Show/hide and enable/disable run button based on course and WebR state
  const runBtn = $('run-btn');
  runBtn.style.display = q.type === 'R' ? '' : 'none';
  runBtn.disabled = !state.webrReady;
  runBtn.title = state.webrReady ? '' : 'Waiting for R engine to load…';

  state.editor?.focus();
}

// ─── Run Code ─────────────────────────────────────────────────
async function runCode() {
  if (!state.webrReady) {
    appendConsole('R engine is still loading — check the status indicator top-right.', 'warn');
    return;
  }
  const code = state.editor?.getValue()?.trim();
  if (!code) return;

  fireGA4('run_code', { question_id: state.currentQuestion?.id ?? 0, client_id: CLIENT_ID });

  const btn = $('run-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-sm"></span>Running…';

  clearConsole();

  const shelter = await new state.webR.Shelter();
  try {
    const result = await shelter.captureR(code, { withAutoprint: true });
    const hasStdout = result.output.some(l => l.type === 'stdout');
    if (!result.output.length) {
      appendConsole('(no output)', 'muted');
    } else {
      result.output.forEach(line => {
        if (line.type === 'stdout')  appendConsole(line.data, 'stdout');
        else                         appendConsole(line.data, 'stderr');
      });
    }
    // Mark question as completed on first successful output
    if (hasStdout && state.currentQuestion) {
      state.completedIds.add(state.currentQuestion.id);
      localStorage.setItem('completedIds', JSON.stringify([...state.completedIds]));
      renderSidebar();
    }
  } catch (err) {
    appendConsole(`Error: ${err.message}`, 'error');
  } finally {
    await shelter.purge();
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>Run';
  }
}

// ─── Console ──────────────────────────────────────────────────
function clearConsole() {
  const el = $('console-output');
  el.innerHTML = '';
}

function appendConsole(text, type = 'stdout') {
  const el = $('console-output');
  // Remove placeholder
  el.querySelector('.console-placeholder')?.remove();
  const line = document.createElement('div');
  line.className = `console-line console-${type}`;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ─── Solution ─────────────────────────────────────────────────
function toggleSolution() {
  const q = state.currentQuestion;
  if (!q) return;

  if (isLocked(q)) {
    const d = new Date(q.release_at);
    alert(`Solution unlocks on ${d.toLocaleString('en-NZ')}`);
    return;
  }

  const panel = $('solution-panel');
  const isHidden = panel.classList.contains('hidden');

  if (isHidden) {
    let solution;
    try { solution = atob(q.solution); } catch { solution = q.solution; }

    const container = $('solution-code');
    container.innerHTML = '';
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dracula' : 'eclipse';
    const cm = CodeMirror(container, {
      mode: q.type === 'R' ? 'r' : 'javascript',
      theme, lineNumbers: true, readOnly: true, value: solution,
    });
    cm.setSize('100%', 'auto');
    container.classList.add('sol-cm');

    panel.classList.remove('hidden');
    $('solution-btn-text').textContent = 'Hide Solution';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    fireGA4('view_solution', { question_id: q.id, client_id: CLIENT_ID });
  } else {
    panel.classList.add('hidden');
    $('solution-btn-text').textContent = 'Show Solution';
  }
}

function copySolution() {
  const q = state.currentQuestion;
  if (!q) return;
  try {
    const text = atob(q.solution);
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('copy-solution-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  } catch { /* ignore */ }
}

// ─── Course Switch ────────────────────────────────────────────
function switchCourse(course) {
  state.currentCourse    = course;
  state.currentQuestion  = null;
  document.querySelectorAll('.course-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.course === course)
  );
  $('welcome-state').classList.remove('hidden');
  $('question-view').classList.add('hidden');
  renderSidebar();
}

// ─── Sidebar ──────────────────────────────────────────────────
function toggleSidebar() { $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar(); }
function openSidebar()  { $('sidebar').classList.add('open');    $('sidebar-overlay').classList.add('visible'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('visible'); }

// ─── GA4 ──────────────────────────────────────────────────────
function fireGA4(name, params = {}) {
  if (typeof gtag === 'function') gtag('event', name, params);
}

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
