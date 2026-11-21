// ===== PART 1: SMALL TOOLS =====
const $ = (s) => document.querySelector(s);
// h() builds a page element safely. Text is added as plain text, so no one can inject HTML.
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat()); return e; };
const show = (...nodes) => $('#app').replaceChildren(...nodes);

let token = sessionStorage.getItem('t');
let role = sessionStorage.getItem('r');
let exam = null; // data of the exam that is running right now

// Every call to the server goes through here and carries the login token
async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { sessionStorage.clear(); token = null; loginView('Session ended. Please login again.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const bar = (title) => h('div', { className: 'bar' }, h('h1', { textContent: title }),
  h('button', { className: 'ghost', textContent: 'Logout', onclick: async () => {
    try { await api('/api/logout', 'POST'); } catch {}
    sessionStorage.clear(); token = null; loginView();
  } }));

// ===== PART 2: LOGIN / REGISTER =====
function loginView(msg = '') {
  const u = h('input', { placeholder: 'Username' });
  const p = h('input', { type: 'password', placeholder: 'Password (at least 8 characters)' });
  const m = h('p', { className: 'msg', textContent: msg });
  const go = (path) => async () => {
    try {
      const d = await api(path, 'POST', { username: u.value, password: p.value });
      if (path === '/api/register') { m.textContent = 'Account created. Now click Login.'; return; }
      token = d.token; role = d.role;
      sessionStorage.setItem('t', token); sessionStorage.setItem('r', role);
      home();
    } catch (e) { m.textContent = e.message; }
  };
  show(h('h1', { textContent: 'Secure Exam System' }),
    h('div', { className: 'card' }, u, p,
      h('div', { className: 'row' },
        h('button', { textContent: 'Login', onclick: go('/api/login') }),
        h('button', { className: 'ghost', textContent: 'Register', onclick: go('/api/register') })), m));
}
const home = () => (role === 'admin' ? adminView() : studentView());

// ===== PART 3: STUDENT - EXAM LIST =====
async function studentView() {
  const list = await api('/api/exams');
  show(bar('My exams'), ...list.map((e) => h('div', { className: 'card' },
    h('b', { textContent: e.title }),
    h('p', { textContent: e.pick_count + ' questions, ' + e.duration_min + ' minutes' }),
    e.status === 'done'
      ? h('p', { textContent: 'Finished. Score: ' + e.score + ' / ' + e.total })
      : h('button', { textContent: e.status === 'running' ? 'Resume exam' : 'Start exam', onclick: () => startExam(e.id) }))));
  if (!list.length) $('#app').append(h('p', { textContent: 'No exams yet. Ask your teacher to create one.' }));
}

// ===== PART 4: STUDENT - TAKING THE EXAM =====
async function startExam(id) {
  try { await document.documentElement.requestFullscreen(); } catch {} // must run inside the click
  let d;
  try { d = await api('/api/exams/' + id + '/start', 'POST'); } catch (e) { alert(e.message); return; }

  const warn = h('p', { className: 'msg' });
  const timerEl = h('b', { className: 'timer' });
  // offset = server clock minus my clock, so a student cannot cheat time by changing the PC clock
  exam = { id: d.attemptId, active: true, busy: false, last: {}, offset: d.serverNow - Date.now(), endsAt: d.endsAt, warn };

  const cards = d.questions.map((q, i) => h('div', { className: 'card noselect' },
    h('p', {}, h('b', { textContent: 'Q' + (i + 1) + '. ' }), q.text),
    ...q.options.map((o, k) => h('label', { className: 'opt' },
      h('input', { type: 'radio', name: 'q' + q.id, checked: d.answers[q.id] === k,
        // autosave: every click goes to the server immediately
        onchange: () => api('/api/attempts/' + exam.id + '/answer', 'POST', { qid: q.id, choice: k }).catch((e) => { warn.textContent = e.message; }) }),
      o))));

  show(h('div', { className: 'bar' }, h('h1', { textContent: d.title }), timerEl), warn, ...cards,
    h('button', { textContent: 'Submit exam', onclick: finishExam }));
  tick(timerEl);
  exam.timer = setInterval(() => tick(timerEl), 1000);
}

function tick(el) {
  const left = Math.max(0, Math.floor((exam.endsAt - (Date.now() + exam.offset)) / 1000));
  el.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
  if (left === 0) finishExam(); // time over -> submit automatically
}

async function finishExam() {
  if (!exam || !exam.active || exam.busy) return;
  exam.busy = true;
  try {
    const r = await api('/api/attempts/' + exam.id + '/submit', 'POST');
    exam.active = false; clearInterval(exam.timer);
    if (document.fullscreenElement) document.exitFullscreen();
    show(bar('Exam finished'), h('div', { className: 'card' },
      h('p', { textContent: 'Your score: ' + r.score + ' / ' + r.total }),
      h('button', { textContent: 'Back to my exams', onclick: studentView })));
  } catch (e) { exam.warn.textContent = e.message; exam.busy = false; } // network problem: will retry
}

// ===== PART 5: CHEAT SIGNALS (sent to the server and counted) =====
function report(type) {
  if (!exam || !exam.active) return;
  const t = Date.now();
  if (exam.last[type] && t - exam.last[type] < 2000) return; // do not count the same action twice
  exam.last[type] = t;
  api('/api/attempts/' + exam.id + '/event', 'POST', { type }).then((r) => {
    exam.warn.textContent = 'Warning: suspicious action noticed (' + r.violations + ' of 5). At 5, your exam is submitted automatically.';
    if (r.autoSubmitted) finishExam();
  }).catch(() => {});
}
window.addEventListener('blur', () => report('tab_switch')); // left the exam tab or window
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) report('fullscreen_exit'); });
['copy', 'cut', 'paste'].forEach((n) => document.addEventListener(n, (e) => { if (exam && exam.active) { e.preventDefault(); report('copy_paste'); } }));
document.addEventListener('contextmenu', (e) => { if (exam && exam.active) { e.preventDefault(); report('right_click'); } });

// ===== PART 6: ADMIN =====
async function adminView() {
  const list = await api('/api/admin/exams');
  const t = h('input', { placeholder: 'Exam title' });
  const m = h('input', { type: 'number', placeholder: 'Duration in minutes' });
  const n = h('input', { type: 'number', placeholder: 'Questions each student gets' });
  const msg = h('p', { className: 'msg' });
  show(bar('Admin panel'),
    h('div', { className: 'card' }, h('b', { textContent: 'Create exam' }), t, m, n,
      h('button', { textContent: 'Create exam', onclick: async () => {
        try { await api('/api/admin/exams', 'POST', { title: t.value, duration_min: +m.value, pick_count: +n.value }); adminView(); }
        catch (e) { msg.textContent = e.message; }
      } }), msg),
    ...list.map((e) => h('div', { className: 'card' },
      h('b', { textContent: e.title }),
      h('p', { textContent: e.questions + ' questions in bank, ' + e.duration_min + ' minutes, ' + e.pick_count + ' per student' }),
      h('div', { className: 'row' },
        h('button', { textContent: 'Add question', onclick: () => questionForm(e) }),
        h('button', { className: 'ghost', textContent: 'See results', onclick: () => results(e) })))));
}

function questionForm(e) {
  const text = h('textarea', { placeholder: 'Question' });
  const opts = [0, 1, 2, 3].map((i) => h('input', { placeholder: 'Option ' + (i + 1) }));
  const right = h('select', {}, ...[0, 1, 2, 3].map((i) => h('option', { value: i, textContent: 'Correct answer: option ' + (i + 1) })));
  const msg = h('p', { className: 'msg' });
  show(bar(e.title), h('div', { className: 'card' }, text, ...opts, right,
    h('button', { textContent: 'Save question', onclick: async () => {
      try {
        await api('/api/admin/exams/' + e.id + '/questions', 'POST', { text: text.value, options: opts.map((o) => o.value), correct: +right.value });
        text.value = ''; opts.forEach((o) => { o.value = ''; }); msg.textContent = 'Saved. Add another one, or go back.';
      } catch (er) { msg.textContent = er.message; }
    } }),
    h('button', { className: 'ghost', textContent: 'Back', onclick: adminView }), msg));
}

async function results(e) {
  const rows = await api('/api/admin/exams/' + e.id + '/results');
  show(bar('Results: ' + e.title),
    h('table', {},
      h('tr', {}, ...['Student', 'Score', 'Status', 'Suspicious actions'].map((x) => h('th', { textContent: x }))),
      ...rows.map((r) => h('tr', {},
        h('td', { textContent: r.username }),
        h('td', { textContent: r.submitted_at ? r.score + '/' + r.total : '-' }),
        h('td', { textContent: r.submitted_at ? 'Submitted' : 'In progress' }),
        h('td', { textContent: r.violations })))),
    h('button', { className: 'ghost', textContent: 'Back', onclick: adminView }));
}

// ===== START =====
token ? home() : loginView();
