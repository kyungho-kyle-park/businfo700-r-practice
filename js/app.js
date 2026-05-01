import { WebR } from 'https://webr.r-wasm.org/latest/webr.mjs';

// ─── State ────────────────────────────────────────────────────
const state = {
  webR:                null,
  webrReady:           false,
  questions:           [],
  currentQuestion:     null,
  currentCourse:       'R',
  editor:              null,
  // 'done' | 'tried' | 'skipped'  persisted across page loads
  questionStatus:      new Map(Object.entries(JSON.parse(localStorage.getItem('questionStatus') || '{}'))),
  collapsedSets:       new Set(JSON.parse(localStorage.getItem('collapsedSets') || '[]')),
  // in-memory only: { [id]: { code, outputHtml } }
  questionEditorState: {},
  // tracks which set envs have been saved to WebR /tmp (in-memory, session only)
  savedSetEnvs:        new Set(),
};

const CLIENT_ID = (() => {
  let id = localStorage.getItem('client_id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('client_id', id); }
  return id;
})();

const $ = id => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  const authed = sessionStorage.getItem('auth') === '1';
  if (authed) {
    showApp();
    startWebR();
  } else {
    $('pwd-modal').classList.remove('hidden');
  }

  $('pwd-form').addEventListener('submit', onPasswordSubmit);
  $('run-btn').addEventListener('click', runCode);
  $('clear-btn').addEventListener('click', () => { state.editor?.setValue(''); state.editor?.focus(); });
  $('clear-console-btn').addEventListener('click', clearConsole);
  $('show-solution-btn').addEventListener('click', toggleSolution);
  $('copy-solution-btn').addEventListener('click', copySolution);
  $('hamburger').addEventListener('click', toggleSidebar);
  $('sidebar-overlay').addEventListener('click', closeSidebar);

  await loadQuestions();
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

  // Init WebR engine once
  if (!state.webR) {
    try {
      state.webR = new WebR();
      await state.webR.init();
    } catch (err) {
      showRetryButton(`Failed to load R engine: ${err.message}`);
      return;
    }
  }

  // Install + load dplyr with up to 3 retries
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      $('load-status').textContent =
        attempt === 1
          ? 'Installing dplyr (first load ~30s)…'
          : `Retrying dplyr install (${attempt}/${MAX_TRIES})…`;

      await state.webR.evalRVoid("webr::install('dplyr')");
      await state.webR.evalRVoid("library(dplyr)");

      state.webrReady = true;
      screen.classList.add('hidden');
      setStatus('ready', 'R Ready');
      $('run-btn').disabled = false;
      return;
    } catch (err) {
      if (attempt === MAX_TRIES) {
        showRetryButton(`dplyr install failed after ${MAX_TRIES} attempts. Check your connection.`);
      }
    }
  }
}

function showRetryButton(message) {
  $('load-status').textContent = message;
  setStatus('error', 'R Error');

  const existing = document.getElementById('retry-btn');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = 'retry-btn';
  btn.textContent = '↺ Retry';
  btn.className = 'btn-primary';
  btn.style.cssText = 'margin-top:12px; font-size:0.85rem; padding:8px 20px;';
  btn.onclick = () => { btn.remove(); startWebR(); };
  $('load-status').insertAdjacentElement('afterend', btn);
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
  state.editor = CodeMirror($('editor-container'), {
    mode: 'r', theme: 'eclipse',
    lineNumbers: true,
    indentUnit: 2, tabSize: 2, indentWithTabs: false,
    lineWrapping: true,
    matchBrackets: true,
    value: '# Write your R code here\n',
    extraKeys: {
      'Ctrl-Enter':   runCode,
      'Cmd-Enter':    runCode,
      'Alt--':        cm => cm.replaceSelection(' <- '),
      'Ctrl-Shift-M': cm => cm.replaceSelection(' %>% '),
    },
  });
  state.editor.setSize('100%', 300);
  setTimeout(() => state.editor.refresh(), 0);
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
  const el   = $('sidebar-content');
  const list = state.questions;
  const weeks = [...new Set(list.map(q => q.week))].sort((a, b) => a - b);

  el.innerHTML = weeks.map(w => {
    const weekQs   = list.filter(q => q.week === w);
    const weekDone = weekQs.filter(q => state.questionStatus.get(String(q.id)) === 'done').length;
    const sets     = [...new Set(weekQs.map(q => q.set))].sort((a, b) => a - b);

    return `
      <div class="sidebar-week">
        <div class="week-header">
          <span class="week-header-label">Week ${w}</span>
          <span class="week-header-line"></span>
          <span class="week-header-count">${weekDone}/${weekQs.length}</span>
        </div>
        ${sets.map(s => {
          const setQs    = weekQs.filter(q => q.set === s);
          const setTitle = setQs[0]?.set_title || `Set ${s}`;
          const setDone  = setQs.filter(q => state.questionStatus.get(String(q.id)) === 'done').length;
          const setKey   = `w${w}s${s}`;
          const collapsed = state.collapsedSets.has(setKey);

          return `
            <div class="sidebar-set">
              <div class="set-header ${collapsed ? 'collapsed' : ''}" data-set-key="${setKey}">
                <svg class="set-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                <span class="set-title-text">Set ${s} · ${setTitle}</span>
                <span class="set-count">${setDone}/${setQs.length}</span>
              </div>
              <ul class="q-list ${collapsed ? 'hidden' : ''}">
                ${setQs.map(q => {
                  const locked  = isLocked(q);
                  const active  = state.currentQuestion?.id === q.id;
                  const status  = state.questionStatus.get(String(q.id));
                  const qNum    = q.id > 100 ? `E${q.id - 100}` : String(q.id);
                  let statusHtml = '';
                  if (locked)                statusHtml = '<span class="q-status locked">🔒</span>';
                  else if (status === 'done')    statusHtml = '<span class="q-status done">✓</span>';
                  else if (status === 'tried')   statusHtml = '<span class="q-status tried">△</span>';
                  // skipped: no indicator
                  return `
                    <li class="q-item ${active ? 'active' : ''} ${locked ? 'locked-item' : ''} ${status === 'done' && !active ? 'done' : ''}"
                        data-id="${q.id}" tabindex="${locked ? -1 : 0}" role="button">
                      <span class="q-num-badge">${qNum}</span>
                      <span class="q-item-title">${q.title}</span>
                      ${statusHtml}
                    </li>`;
                }).join('')}
              </ul>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');

  el.querySelectorAll('.set-header').forEach(h =>
    h.addEventListener('click', () => toggleSet(h.dataset.setKey))
  );
  el.querySelectorAll('.q-item:not(.locked-item)').forEach(item => {
    const select = () => selectQuestion(parseInt(item.dataset.id));
    item.addEventListener('click', select);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') select(); });
  });
}

function isLocked(q) { return new Date() < new Date(q.release_at); }

function toggleSet(setKey) {
  if (state.collapsedSets.has(setKey)) state.collapsedSets.delete(setKey);
  else state.collapsedSets.add(setKey);
  localStorage.setItem('collapsedSets', JSON.stringify([...state.collapsedSets]));
  renderSidebar();
}

async function selectQuestion(id) {
  const q = state.questions.find(x => x.id === id);
  if (!q) return;

  // Save current question's editor + output before switching
  if (state.currentQuestion) {
    saveEditorState(state.currentQuestion.id);
    // Mark as skipped if they never ran code on this question
    if (!state.questionStatus.has(String(state.currentQuestion.id))) {
      state.questionStatus.set(String(state.currentQuestion.id), 'skipped');
      saveQuestionStatus();
    }
    // Save/restore WebR environment when moving to a different set
    const fromSetKey = `w${state.currentQuestion.week}s${state.currentQuestion.set}`;
    const toSetKey   = `w${q.week}s${q.set}`;
    if (fromSetKey !== toSetKey && state.webrReady) {
      await switchSetEnvironment(state.currentQuestion, q);
    }
  }

  state.currentQuestion = q;
  renderSidebar();
  renderQuestion(q);
  if (window.innerWidth < 768) closeSidebar();

  fireGA4('question_select', { question_id: q.id, week: q.week, set: q.set, client_id: CLIENT_ID });
}

async function switchSetEnvironment(fromQ, toQ) {
  const fromKey = `w${fromQ.week}s${fromQ.set}`;
  const toKey   = `w${toQ.week}s${toQ.set}`;

  // Save current set's environment if any variables exist
  try {
    await state.webR.evalRVoid(
      `if (length(ls(envir = globalenv())) > 0) save(list = ls(envir = globalenv()), file = '/tmp/env_${fromKey}.RData', envir = globalenv())`
    );
    state.savedSetEnvs.add(fromKey);
  } catch { /* ignore */ }

  // Clear global environment
  await state.webR.evalRVoid('rm(list = ls())').catch(() => {});

  // Restore target set's environment if it was previously saved
  if (state.savedSetEnvs.has(toKey)) {
    try {
      await state.webR.evalRVoid(`load('/tmp/env_${toKey}.RData')`);
    } catch { /* ignore */ }
  } else {
    resetEnvironment();
  }
}

function renderQuestion(q) {
  $('welcome-state').classList.add('hidden');
  $('question-view').classList.remove('hidden');

  $('q-badge').textContent    = `W${q.week} · Q${q.id}`;
  const typeBadge = $('q-type');
  typeBadge.textContent = 'R';
  typeBadge.className   = 'q-type-badge r-type';
  $('q-title').textContent  = q.title;
  $('q-scenario').innerHTML = q.scenario || '';
  $('q-task').innerHTML     = q.task;

  // Restore saved editor + output, or initialise fresh for first visit
  restoreEditorState(q.id, q.starter);

  // Refresh environment display
  if (state.webrReady) inspectEnvironment();

  const expectedPanel = $('expected-panel');
  const expectedEl    = $('q-expected');
  if (q.expected) {
    expectedEl.textContent = q.expected;
    expectedPanel.classList.remove('hidden');
  } else {
    expectedEl.textContent = '';
    expectedPanel.classList.add('hidden');
  }

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

  const runBtn = $('run-btn');
  runBtn.disabled = !state.webrReady;
  runBtn.title = state.webrReady ? '' : 'Waiting for R engine to load…';

  state.editor?.focus();
}

// ─── Editor State (per-question, in-memory) ───────────────────
function saveEditorState(id) {
  state.questionEditorState[id] = {
    code:       state.editor?.getValue() || '',
    outputHtml: $('console-output').innerHTML,
  };
}

function restoreEditorState(id, starter) {
  const saved = state.questionEditorState[id];
  if (saved) {
    state.editor?.setValue(saved.code);
    $('console-output').innerHTML = saved.outputHtml;
  } else {
    state.editor?.setValue(starter || '# Write your code here\n');
    clearConsole();
  }
}

// ─── Run Code ─────────────────────────────────────────────────
async function runCode() {
  if (!state.webrReady) {
    appendConsole('R engine is still loading — check the status indicator top-right.', 'warn');
    return;
  }
  const code = state.editor?.getValue()?.trim();
  if (!code) return;

  fireGA4('run_code', { question_id: state.currentQuestion?.id ?? 0, week: state.currentQuestion?.week ?? 0, set: state.currentQuestion?.set ?? 0, client_id: CLIENT_ID });

  const btn = $('run-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-sm"></span>Running…';

  clearConsole();

  const shelter = await new state.webR.Shelter();
  try {
    const result = await shelter.captureR(code, { withAutoprint: true });
    const stdoutLines = result.output.filter(l => l.type === 'stdout');
    const hasStdout   = stdoutLines.length > 0;

    if (!result.output.length) {
      appendConsole('(no output)', 'muted');
    } else {
      result.output.forEach(line => {
        if (line.type === 'stdout') appendConsole(line.data, 'stdout');
        else                        appendConsole(line.data, 'stderr');
      });
    }

    if (hasStdout && state.currentQuestion) {
      state.questionStatus.set(String(state.currentQuestion.id), 'done');
      saveQuestionStatus();
      renderSidebar();
    }

    await inspectEnvironment();
  } catch (err) {
    appendConsole(`Error: ${err.message}`, 'error');
    fireGA4('run_error', { question_id: state.currentQuestion?.id ?? 0, week: state.currentQuestion?.week ?? 0, set: state.currentQuestion?.set ?? 0, error_message: err.message, client_id: CLIENT_ID });
  } finally {
    await shelter.purge();
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>Run';
  }
}

function saveQuestionStatus() {
  localStorage.setItem('questionStatus', JSON.stringify(Object.fromEntries(state.questionStatus)));
}

// ─── Console ──────────────────────────────────────────────────
function clearConsole() {
  $('console-output').innerHTML = '';
}

function appendConsole(text, type = 'stdout') {
  const el = $('console-output');
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
    try { solution = b64Decode(q.solution); } catch { solution = q.solution; }

    const container = $('solution-code');
    container.innerHTML = '';

    panel.classList.remove('hidden');
    $('solution-btn-text').textContent = 'Hide Solution';

    const cm = CodeMirror(container, {
      mode: 'r', theme: 'eclipse', lineNumbers: true, readOnly: true, value: solution,
    });
    cm.setSize('100%', 'auto');
    container.classList.add('sol-cm');

    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    fireGA4('view_solution', { question_id: q.id, week: q.week, set: q.set, client_id: CLIENT_ID });
  } else {
    panel.classList.add('hidden');
    $('solution-btn-text').textContent = 'Show Solution';
  }
}

function copySolution() {
  const q = state.currentQuestion;
  if (!q) return;
  try {
    const text = b64Decode(q.solution);
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('copy-solution-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  } catch { /* ignore */ }
}

// ─── Course Switch ────────────────────────────────────────────
// ─── Sidebar ──────────────────────────────────────────────────
function toggleSidebar() { $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar(); }
function openSidebar()  { $('sidebar').classList.add('open');    $('sidebar-overlay').classList.add('visible'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('visible'); }

// ─── Environment Inspector ────────────────────────────────────
function resetEnvironment() {
  $('env-content').innerHTML = '<span class="env-placeholder">Run code to inspect variables…</span>';
}

async function inspectEnvironment() {
  if (!state.webrReady) return;
  const shelter = await new state.webR.Shelter();
  try {
    const result = await shelter.captureR(`
      local({
        nms <- ls(envir = globalenv())
        nms <- nms[!startsWith(nms, ".")]
        if (length(nms) == 0) {
          cat("__EMPTY__\\n")
        } else {
          for (nm in nms) {
            x <- tryCatch(get(nm, envir = globalenv()), error = function(e) NULL)
            if (is.null(x)) next
            cl <- paste(class(x), collapse = "/")
            sz <- tryCatch({
              if (is.data.frame(x))      paste0(nrow(x), " x ", ncol(x), " cols")
              else if (!is.null(dim(x))) paste(dim(x), collapse = " x ")
              else                       as.character(length(x))
            }, error = function(e) "?")
            pv <- tryCatch({
              if (is.data.frame(x))     paste0("[", paste(names(x), collapse = ", "), "]")
              else if (is.factor(x))    paste(levels(x)[seq_len(min(5, nlevels(x)))], collapse = ", ")
              else if (length(x) <= 6)  paste(format(x), collapse = " ")
              else                      paste(c(format(head(x, 4)), "..."), collapse = " ")
            }, error = function(e) "—")
            cat(paste0(nm, "\\t", cl, "\\t", sz, "\\t", pv, "\\n"))
          }
        }
      })
    `, { withAutoprint: false });

    const raw = result.output
      .filter(l => l.type === 'stdout')
      .map(l => l.data)
      .join('\n').trim();

    renderEnvironment(raw);
  } catch { /* silently ignore */ } finally {
    await shelter.purge();
  }
}

function renderEnvironment(raw) {
  const container = $('env-content');
  if (!raw || raw === '__EMPTY__') {
    container.innerHTML = '<span class="env-placeholder">No variables in environment</span>';
    return;
  }
  const rows = raw.split('\n').filter(Boolean).map(line => {
    const [name, type, size, ...rest] = line.split('\t');
    return { name: name||'', type: type||'', size: size||'', preview: rest.join('\t') };
  });
  container.innerHTML = `
    <table class="env-table">
      <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Value</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td class="env-name">${esc(r.name)}</td>
          <td class="env-type">${esc(r.type)}</td>
          <td class="env-size">${esc(r.size)}</td>
          <td class="env-preview" title="${esc(r.preview)}">${esc(r.preview)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function b64Decode(str) {
  try {
    return decodeURIComponent(
      atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
  } catch { return atob(str); }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── GA4 ──────────────────────────────────────────────────────
function fireGA4(name, params = {}) {
  window.dataLayer = window.dataLayer || [];
  dataLayer.push({ event: name, ...params });
}

// ─── Global key intercept (override Chrome shortcuts) ─────────
window.addEventListener('keydown', e => {
  if (!state.editor?.hasFocus()) return;
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.editor.replaceSelection(' %>% ');
  }
}, true);

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
