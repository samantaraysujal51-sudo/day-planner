require('dotenv').config();
const express = require('express'), mysql = require('mysql2/promise'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* allow the page to be opened from another port (e.g. VS Code Live Server) or file:// */
app.use('/api', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
let dbReady = false, dbError = 'Starting up...';
app.get('/api/health', (req, res) => res.json({ app: 'day-planner', ok: true, db: dbReady, dbError: dbReady ? null : dbError }));
app.use('/api', (req, res, next) =>
  dbReady ? next() : res.status(503).json({ error: 'Database is not connected: ' + dbError + ' (check MySQL is running and .env is correct, then restart).' }));

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const DB = process.env.DB_NAME || 'day_planner';
const cfg = {
  host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', dateStrings: true,
};
if (process.env.DB_SSL === 'true') cfg.ssl = { rejectUnauthorized: false };
let db;

/* ---------- database setup (runs automatically on start) ---------- */
async function init() {
  try { const c = await mysql.createConnection(cfg); await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``); await c.end(); }
  catch (e) { console.log('(Skipped CREATE DATABASE:', e.message + ')'); }
  db = mysql.createPool({ ...cfg, database: DB, connectionLimit: 10 });
  const T = [
    `CREATE TABLE IF NOT EXISTS students (
      student_id INT AUTO_INCREMENT PRIMARY KEY, student_name VARCHAR(100) NOT NULL,
      email VARCHAR(120) NOT NULL UNIQUE, phone CHAR(10) NOT NULL, password VARCHAR(100) NOT NULL,
      course_class VARCHAR(50) NOT NULL, registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS admins (
      admin_id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE, password VARCHAR(100) NOT NULL,
      role VARCHAR(20) DEFAULT 'Admin', status VARCHAR(20) DEFAULT 'Active')`,
    `CREATE TABLE IF NOT EXISTS categories (
      category_id INT AUTO_INCREMENT PRIMARY KEY, student_id INT NULL, category_name VARCHAR(40) NOT NULL,
      color CHAR(7) NOT NULL, description VARCHAR(100) NULL,
      FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS tasks (
      task_id INT AUTO_INCREMENT PRIMARY KEY, student_id INT NOT NULL, category_id INT NOT NULL,
      title VARCHAR(150) NOT NULL, task_date DATE NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
      priority ENUM('Low','Medium','High') DEFAULT 'Medium', repeat_type ENUM('none','daily','weekly') DEFAULT 'none',
      remind_minutes INT DEFAULT 30, remind_on TINYINT(1) DEFAULT 1, notes TEXT NULL,
      FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(category_id))`,
    `CREATE TABLE IF NOT EXISTS task_log (
      log_id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, log_date DATE NOT NULL,
      status_change VARCHAR(20) NOT NULL, change_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY one_per_day (task_id, log_date), FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE)`,
  ];
  for (const q of T) await db.query(q);
  const [[{ n }]] = await db.query('SELECT COUNT(*) n FROM categories WHERE student_id IS NULL');
  if (!n) await db.query('INSERT INTO categories (category_name,color) VALUES ?', [[
    ['Exam', '#8b5cf6'], ['Gym', '#16a34a'], ['Work', '#2563eb'], ['Reel', '#db2777'], ['Personal', '#d97706'], ['Class', '#0ea5e9']]]);
  const aUser = (process.env.ADMIN_USER || 'admin').trim(), aPass = process.env.ADMIN_PASSWORD || 'admin123';
  const [[adm]] = await db.query('SELECT admin_id, password FROM admins WHERE username=?', [aUser]);
  if (!adm) {
    await db.query('INSERT INTO admins (username,password) VALUES (?,?)', [aUser, await bcrypt.hash(aPass, 10)]);
    console.log(`Admin account created: ${aUser}`);
  } else if (!(await bcrypt.compare(aPass, adm.password))) {
    // .env is the source of truth for the admin password
    await db.query("UPDATE admins SET password=?, status='Active' WHERE admin_id=?", [await bcrypt.hash(aPass, 10), adm.admin_id]);
    console.log(`Admin password for "${aUser}" updated from .env`);
  }
}

/* ---------- helpers ---------- */
const dbMsg = e => ({
  ECONNREFUSED: 'MySQL is not running or DB_HOST/DB_PORT is wrong',
  ER_ACCESS_DENIED_ERROR: 'wrong DB_USER / DB_PASSWORD in .env',
  ENOTFOUND: 'DB_HOST not found', ETIMEDOUT: 'timed out reaching MySQL (DB_HOST/DB_PORT/firewall?)',
  ER_BAD_DB_ERROR: 'database "' + DB + '" does not exist and could not be created',
}[e.code] || e.message);
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: 'Server error: ' + dbMsg(e) });
});
const auth = role => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    if (role && u.role !== role) throw 0;
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in again' }); }
};
const S = auth('student'), A = auth('admin');
const bad = (res, msg) => res.status(400).json({ error: msg });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^\d{2}:\d{2}(:\d{2})?$/.test(s || '');

function checkProfile(b) {
  if (!/^[A-Za-z][A-Za-z .'-]{1,98}$/.test((b.name || '').trim())) return 'Enter a valid full name (letters only).';
  if (!/^\d{10}$/.test(b.phone || '')) return 'Phone number must be exactly 10 digits.';
  if (!(b.course_class || '').trim()) return 'Class name is required.';
}

/* expand repeating tasks into per-day occurrences and attach status from task_log */
async function occurrences(sid, from, to) {
  const [tasks] = await db.query(
    `SELECT t.*, c.category_name, c.color FROM tasks t JOIN categories c ON c.category_id=t.category_id
     WHERE t.student_id=? AND t.task_date<=? AND (t.repeat_type<>'none' OR t.task_date>=?)`, [sid, to, from]);
  const [logs] = await db.query(
    `SELECT task_id, log_date, status_change FROM task_log WHERE log_date BETWEEN ? AND ?
     AND task_id IN (SELECT task_id FROM tasks WHERE student_id=?)`, [from, to, sid]);
  const st = {}; logs.forEach(l => st[l.task_id + '|' + l.log_date] = l.status_change);
  const out = [], end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(from + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    for (const t of tasks) {
      const hit = t.repeat_type === 'none' ? t.task_date === day
        : t.repeat_type === 'daily' ? day >= t.task_date
        : day >= t.task_date && d.getUTCDay() === new Date(t.task_date + 'T00:00:00Z').getUTCDay();
      if (hit) out.push({ ...t, date: day, status: st[t.task_id + '|' + day] || 'Pending' });
    }
  }
  return out.sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
}
const range = q => {
  if (!isDate(q.from) || !isDate(q.to)) return null;
  const days = (new Date(q.to) - new Date(q.from)) / 864e5;
  return days >= 0 && days <= 120 ? [q.from, q.to] : null;
};

/* ---------- auth ---------- */
app.post('/api/signup', wrap(async (req, res) => {
  const b = req.body, err = checkProfile(b);
  if (err) return bad(res, err);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) return bad(res, 'Enter a valid email address.');
  if ((b.password || '').length !== 8) return bad(res, 'Password must be exactly 8 characters.');
  const [ex] = await db.query('SELECT 1 FROM students WHERE email=?', [b.email.toLowerCase()]);
  if (ex.length) return bad(res, 'An account with this email already exists.');
  await db.query('INSERT INTO students (student_name,email,phone,password,course_class) VALUES (?,?,?,?,?)',
    [b.name.trim(), b.email.toLowerCase(), b.phone, await bcrypt.hash(b.password, 10), b.course_class.trim()]);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { role, identifier = '', password = '' } = req.body;
  let u;
  if (role === 'admin') {
    [[u]] = await db.query("SELECT admin_id id, username name, password FROM admins WHERE username=? AND status='Active'", [identifier]);
  } else {
    [[u]] = await db.query('SELECT student_id id, student_name name, course_class, password FROM students WHERE email=?', [identifier.toLowerCase()]);
  }
  if (!u || !(await bcrypt.compare(password, u.password))) return bad(res, 'Wrong login or password.');
  const r = role === 'admin' ? 'admin' : 'student';
  res.json({ token: jwt.sign({ id: u.id, role: r }, SECRET, { expiresIn: '7d' }), me: { role: r, name: u.name, course_class: u.course_class || '' } });
}));

/* ---------- student: profile ---------- */
app.get('/api/me', S, wrap(async (req, res) => {
  const [[u]] = await db.query('SELECT student_name name,email,phone,course_class FROM students WHERE student_id=?', [req.user.id]);
  res.json(u);
}));
app.put('/api/me', S, wrap(async (req, res) => {
  const err = checkProfile(req.body); if (err) return bad(res, err);
  const b = req.body;
  await db.query('UPDATE students SET student_name=?,phone=?,course_class=? WHERE student_id=?', [b.name.trim(), b.phone, b.course_class.trim(), req.user.id]);
  res.json({ ok: true });
}));

/* ---------- student: categories ---------- */
app.get('/api/categories', S, wrap(async (req, res) => {
  const [r] = await db.query('SELECT category_id,category_name,color,student_id IS NULL AS builtin FROM categories WHERE student_id IS NULL OR student_id=? ORDER BY category_id', [req.user.id]);
  res.json(r);
}));
app.post('/api/categories', S, wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 40) return bad(res, 'Enter a category name (max 40 characters).');
  if (!/^#[0-9a-fA-F]{6}$/.test(req.body.color || '')) return bad(res, 'Pick a valid colour.');
  const [r] = await db.query('INSERT INTO categories (student_id,category_name,color) VALUES (?,?,?)', [req.user.id, name, req.body.color]);
  res.json({ category_id: r.insertId });
}));

/* ---------- student: tasks ---------- */
async function cleanTask(b, sid) {
  const t = {
    title: (b.title || '').trim(), category_id: +b.category_id, task_date: b.task_date, start_time: b.start_time, end_time: b.end_time,
    priority: b.priority, repeat_type: b.repeat_type, remind_minutes: +b.remind_minutes, remind_on: b.remind_on === false || b.remind_on === 0 ? 0 : 1,
    notes: (b.notes || '').slice(0, 1000),
  };
  if (!t.title) return 'Please enter a title.';
  if (!isDate(t.task_date)) return 'Please pick a date.';
  if (!isTime(t.start_time) || !isTime(t.end_time)) return 'Please set start and end time.';
  if (t.end_time <= t.start_time) return 'End time must be after start time.';
  if (!['Low', 'Medium', 'High'].includes(t.priority)) return 'Choose a priority.';
  if (!['none', 'daily', 'weekly'].includes(t.repeat_type)) return 'Choose a repeat option.';
  if (!(t.remind_minutes >= 0 && t.remind_minutes <= 10080)) return 'Invalid reminder.';
  const [c] = await db.query('SELECT 1 FROM categories WHERE category_id=? AND (student_id IS NULL OR student_id=?)', [t.category_id, sid]);
  if (!c.length) return 'Choose a category.';
  return t;
}
const COLS = ['title', 'category_id', 'task_date', 'start_time', 'end_time', 'priority', 'repeat_type', 'remind_minutes', 'remind_on', 'notes'];

app.get('/api/tasks', S, wrap(async (req, res) => {
  const r = range(req.query); if (!r) return bad(res, 'Invalid date range.');
  res.json(await occurrences(req.user.id, ...r));
}));
app.get('/api/routines', S, wrap(async (req, res) => {
  const [r] = await db.query(`SELECT t.*, c.category_name, c.color FROM tasks t JOIN categories c ON c.category_id=t.category_id
    WHERE t.student_id=? AND t.repeat_type<>'none' ORDER BY t.start_time`, [req.user.id]);
  res.json(r);
}));
app.post('/api/tasks', S, wrap(async (req, res) => {
  const t = await cleanTask(req.body, req.user.id); if (typeof t === 'string') return bad(res, t);
  await db.query(`INSERT INTO tasks (student_id,${COLS}) VALUES (?,${COLS.map(() => '?')})`, [req.user.id, ...COLS.map(c => t[c])]);
  res.json({ ok: true });
}));
app.put('/api/tasks/:id', S, wrap(async (req, res) => {
  const t = await cleanTask(req.body, req.user.id); if (typeof t === 'string') return bad(res, t);
  await db.query(`UPDATE tasks SET ${COLS.map(c => c + '=?')} WHERE task_id=? AND student_id=?`, [...COLS.map(c => t[c]), req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.delete('/api/tasks/:id', S, wrap(async (req, res) => {
  await db.query('DELETE FROM tasks WHERE task_id=? AND student_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/tasks/:id/status', S, wrap(async (req, res) => {
  const { date, status } = req.body;
  if (!isDate(date) || !['Pending', 'Completed', 'Missed'].includes(status)) return bad(res, 'Invalid status.');
  const [own] = await db.query('SELECT 1 FROM tasks WHERE task_id=? AND student_id=?', [req.params.id, req.user.id]);
  if (!own.length) return bad(res, 'Task not found.');
  if (status === 'Pending') await db.query('DELETE FROM task_log WHERE task_id=? AND log_date=?', [req.params.id, date]);
  else await db.query('INSERT INTO task_log (task_id,log_date,status_change) VALUES (?,?,?) ON DUPLICATE KEY UPDATE status_change=VALUES(status_change), change_date=NOW()', [req.params.id, date, status]);
  res.json({ ok: true });
}));
app.put('/api/tasks/:id/remind', S, wrap(async (req, res) => {
  await db.query('UPDATE tasks SET remind_on=? WHERE task_id=? AND student_id=?', [req.body.on ? 1 : 0, req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* ---------- admin ---------- */
app.get('/api/admin/students', A, wrap(async (req, res) => {
  const [r] = await db.query(`SELECT s.student_id,s.student_name,s.email,s.phone,s.course_class,s.registration_date,
    (SELECT COUNT(*) FROM tasks t WHERE t.student_id=s.student_id) AS tasks,
    (SELECT COUNT(*) FROM task_log l JOIN tasks t ON t.task_id=l.task_id WHERE t.student_id=s.student_id AND l.status_change='Completed') AS completed
    FROM students s ORDER BY s.student_id DESC`);
  res.json(r);
}));
app.get('/api/admin/students/:id/tasks', A, wrap(async (req, res) => {
  const r = range(req.query); if (!r) return bad(res, 'Invalid date range.');
  res.json(await occurrences(+req.params.id, ...r));
}));
app.delete('/api/admin/students/:id', A, wrap(async (req, res) => {
  await db.query('DELETE FROM students WHERE student_id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

async function connectDb() {
  try { await init(); dbReady = true; dbError = null; console.log('Database connected. Ready!'); }
  catch (e) {
    dbError = dbMsg(e);
    console.error(`\nDatabase not connected: ${dbError}\n(${e.code || ''} ${e.message})\nRetrying in 5 seconds... Fix .env / start MySQL.\n`);
    setTimeout(connectDb, 5000);
  }
}
const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => { console.log(`Day Planner running at http://localhost:${port}`); connectDb(); });
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Close the other terminal running this app, or set PORT=3001 in .env.` : e.message);
  process.exit(1);
});
