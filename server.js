// ============ PART 1: SETUP ============
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const MAX_VIOLATIONS = 5; // after this many suspicious actions, exam is auto-submitted
const SESSION_MS = 8 * 3600 * 1000; // login lasts 8 hours

// ============ PART 2: DATABASE (5 tables) ============
const db = new Database('exam.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, token TEXT, token_at INTEGER);
CREATE TABLE IF NOT EXISTS exams(id INTEGER PRIMARY KEY, title TEXT, duration_min INTEGER, pick_count INTEGER);
CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY, exam_id INTEGER, text TEXT, options TEXT, correct INTEGER, marks INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, exam_id INTEGER, user_id INTEGER, ends_at INTEGER, submitted_at INTEGER, score INTEGER, total INTEGER, paper TEXT, answers TEXT DEFAULT '{}', UNIQUE(exam_id, user_id));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, attempt_id INTEGER, type TEXT, at INTEGER);
`);

// First run: create one admin with a random password and print it
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const pw = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)').run('admin', bcrypt.hashSync(pw, 10), 'admin');
  console.log('ADMIN CREATED -> username: admin   password: ' + pw);
}

// ============ PART 3: SMALL HELPERS ============
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Fair shuffle using strong randomness (Math.random is guessable)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Block a login after 5 wrong tries for 10 minutes
const tries = new Map();
const isLocked = (k) => { const t = tries.get(k); return t && t.n >= 5 && now() < t.until; };
const addFail = (k) => { const t = tries.get(k) || { n: 0 }; t.n++; t.until = now() + 600000; tries.set(k, t); };

// Marks the exam on the SERVER. The browser never sees correct answers.
function finish(a) {
  const paper = JSON.parse(a.paper);
  const answers = JSON.parse(a.answers);
  const qs = db.prepare('SELECT id, correct, marks FROM questions WHERE exam_id=?').all(a.exam_id);
  const byId = Object.fromEntries(qs.map((q) => [q.id, q]));
  let score = 0, total = 0;
  for (const p of paper) {
    const q = byId[p.qid];
    total += q.marks;
    const pick = answers[p.qid];
    // student picked a SHUFFLED position; p.order turns it back to the original option number
    if (pick !== undefined && p.order[pick] === q.correct) score += q.marks;
  }
  db.prepare('UPDATE attempts SET submitted_at=?, score=?, total=? WHERE id=?').run(now(), score, total, a.id);
}
const finishExpired = (userId) => {
  const rows = userId
    ? db.prepare('SELECT * FROM attempts WHERE user_id=? AND submitted_at IS NULL AND ends_at<?').all(userId, now())
    : db.prepare('SELECT * FROM attempts WHERE submitted_at IS NULL AND ends_at<?').all(now());
  rows.forEach(finish);
};

// ============ PART 4: APP + SECURITY HEADERS ============
const app = express();
app.use(express.json({ limit: '20kb' })); // refuse huge requests
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'", // only our own scripts run
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', // nobody can put our page inside another site
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ============ PART 5: LOGIN CHECK (middleware) ============
function auth(role) {
  return (req, res, next) => {
    const token = (req.get('Authorization') || '').replace('Bearer ', '');
    const u = token && db.prepare('SELECT * FROM users WHERE token=?').get(sha(token));
    if (!u || now() - u.token_at > SESSION_MS) return res.status(401).json({ error: 'Please login again' });
    if (role && u.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = u;
    next();
  };
}

// ============ PART 6: ACCOUNTS ============
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username) || password.length < 8)
    return res.status(400).json({ error: 'Username: 3-20 letters/numbers. Password: at least 8 characters.' });
  try {
    db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)').run(username, bcrypt.hashSync(password, 10), 'student');
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'This username is already taken' }); }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const key = req.ip + '|' + username;
  if (isLocked(key)) return res.status(429).json({ error: 'Too many wrong tries. Wait 10 minutes.' });
  const u = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || typeof password !== 'string' || !bcrypt.compareSync(password, u.password_hash)) {
    addFail(key);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  tries.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  // Only ONE token per user: a new login replaces the old one, so the old device is logged out
  db.prepare('UPDATE users SET token=?, token_at=? WHERE id=?').run(sha(token), now(), u.id);
  res.json({ token, role: u.role });
});

app.post('/api/logout', auth(), (req, res) => {
  db.prepare('UPDATE users SET token=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

// ============ PART 7: STUDENT - EXAMS ============
app.get('/api/exams', auth(), (req, res) => {
  finishExpired(req.user.id);
  const rows = db.prepare(
    'SELECT e.id, e.title, e.duration_min, e.pick_count, a.id attempt_id, a.submitted_at, a.score, a.total FROM exams e LEFT JOIN attempts a ON a.exam_id=e.id AND a.user_id=?'
  ).all(req.user.id);
  res.json(rows.map((r) => ({ ...r, status: !r.attempt_id ? 'new' : r.submitted_at ? 'done' : 'running' })));
});

app.post('/api/exams/:id/start', auth('student'), (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  let a = db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, req.user.id);
  if (a && (a.submitted_at || now() > a.ends_at)) {
    if (!a.submitted_at) finish(a);
    return res.status(400).json({ error: 'You have already finished this exam' }); // only one attempt allowed
  }
  if (!a) {
    const pool = db.prepare('SELECT id FROM questions WHERE exam_id=?').all(exam.id).map((q) => q.id);
    if (!pool.length) return res.status(400).json({ error: 'This exam has no questions yet' });
    // Every student gets different random questions and a different option order
    const paper = shuffle(pool).slice(0, exam.pick_count).map((qid) => ({ qid, order: shuffle([0, 1, 2, 3]) }));
    const info = db.prepare('INSERT INTO attempts(exam_id, user_id, ends_at, paper) VALUES(?,?,?,?)')
      .run(exam.id, req.user.id, now() + exam.duration_min * 60000, JSON.stringify(paper)); // timer is fixed by the SERVER clock
    a = db.prepare('SELECT * FROM attempts WHERE id=?').get(info.lastInsertRowid);
  }
  const questions = JSON.parse(a.paper).map((p) => {
    const q = db.prepare('SELECT text, options FROM questions WHERE id=?').get(p.qid); // note: "correct" is NOT selected
    const opts = JSON.parse(q.options);
    return { id: p.qid, text: q.text, options: p.order.map((i) => opts[i]) };
  });
  res.json({ attemptId: a.id, title: exam.title, endsAt: a.ends_at, serverNow: now(), questions, answers: JSON.parse(a.answers) });
});

// Loads the student's own running attempt, and refuses if time is over
function myAttempt(req, res, next) {
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.submitted_at) return res.status(400).json({ error: 'Exam already submitted' });
  if (now() > a.ends_at + 3000) { finish(a); return res.status(400).json({ error: 'Time is over. Your exam was submitted.' }); }
  req.attempt = a;
  next();
}

app.post('/api/attempts/:id/answer', auth('student'), myAttempt, (req, res) => {
  const { qid, choice } = req.body;
  const ok = JSON.parse(req.attempt.paper).some((p) => p.qid === qid);
  if (!ok || ![0, 1, 2, 3].includes(choice)) return res.status(400).json({ error: 'Bad answer' });
  const answers = JSON.parse(req.attempt.answers);
  answers[qid] = choice; // autosave: each click is stored at once
  db.prepare('UPDATE attempts SET answers=? WHERE id=?').run(JSON.stringify(answers), req.attempt.id);
  res.json({ ok: true });
});

app.post('/api/attempts/:id/event', auth('student'), myAttempt, (req, res) => {
  const type = req.body.type;
  if (!['tab_switch', 'fullscreen_exit', 'copy_paste', 'right_click'].includes(type)) return res.status(400).json({ error: 'Bad event' });
  db.prepare('INSERT INTO events(attempt_id, type, at) VALUES(?,?,?)').run(req.attempt.id, type, now());
  const n = db.prepare('SELECT COUNT(*) c FROM events WHERE attempt_id=?').get(req.attempt.id).c;
  if (n >= MAX_VIOLATIONS) finish(req.attempt);
  res.json({ violations: n, autoSubmitted: n >= MAX_VIOLATIONS });
});

app.post('/api/attempts/:id/submit', auth('student'), (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!a.submitted_at) finish(a);
  res.json(db.prepare('SELECT score, total FROM attempts WHERE id=?').get(a.id));
});

// ============ PART 8: ADMIN ============
app.get('/api/admin/exams', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT e.*, (SELECT COUNT(*) FROM questions WHERE exam_id=e.id) questions FROM exams e').all());
});

app.post('/api/admin/exams', auth('admin'), (req, res) => {
  const { title, duration_min, pick_count } = req.body;
  if (!title || !(duration_min > 0) || !(pick_count > 0)) return res.status(400).json({ error: 'Fill title, minutes and number of questions' });
  const r = db.prepare('INSERT INTO exams(title, duration_min, pick_count) VALUES(?,?,?)').run(String(title).slice(0, 100), Math.floor(duration_min), Math.floor(pick_count));
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/admin/exams/:id/questions', auth('admin'), (req, res) => {
  const { text, options, correct } = req.body;
  if (!text || !Array.isArray(options) || options.length !== 4 || options.some((o) => !o) || ![0, 1, 2, 3].includes(correct))
    return res.status(400).json({ error: 'Write the question, all 4 options, and pick the correct one' });
  db.prepare('INSERT INTO questions(exam_id, text, options, correct) VALUES(?,?,?,?)')
    .run(req.params.id, String(text).slice(0, 1000), JSON.stringify(options.map((o) => String(o).slice(0, 300))), correct);
  res.json({ ok: true });
});

app.get('/api/admin/exams/:id/results', auth('admin'), (req, res) => {
  finishExpired();
  res.json(db.prepare(
    'SELECT u.username, a.score, a.total, a.submitted_at, (SELECT COUNT(*) FROM events WHERE attempt_id=a.id) violations FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.exam_id=?'
  ).all(req.params.id));
});

app.listen(3000, () => console.log('Exam system running -> open http://localhost:3000'));
