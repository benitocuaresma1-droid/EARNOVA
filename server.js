require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TASK_REWARD_PHP = Math.max(0.01, Number(process.env.TASK_REWARD_PHP || 3));
const MIN_WITHDRAWAL_PHP = Math.max(0.01, Number(process.env.MIN_WITHDRAWAL_PHP || 50));
const REFERRAL_BONUS_PHP = Math.max(0, Number(process.env.REFERRAL_BONUS_PHP || 0));
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "local-development-secret-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { error: "Too many attempts. Please try again later." } });
const taskLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, message: { error: "Please slow down." } });

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 display_name TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
 balance_php NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance_php >= 0),
 referral_code TEXT UNIQUE NOT NULL,
 referred_by BIGINT REFERENCES users(id),
 is_banned BOOLEAN NOT NULL DEFAULT FALSE,
 ban_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_task_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS activation_codes (
 code TEXT PRIMARY KEY,
 created_by BIGINT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 used_by BIGINT REFERENCES users(id),
 used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS tasks (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_type TEXT NOT NULL,
 question TEXT NOT NULL,
 answer_hash TEXT NOT NULL,
 reward_php NUMERIC(12,2) NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS transactions (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 amount_php NUMERIC(12,2) NOT NULL,
 description TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS withdrawals (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id),
 amount_php NUMERIC(12,2) NOT NULL,
 method TEXT NOT NULL CHECK (method IN ('GCash','Maya')),
 account_name TEXT NOT NULL,
 account_number TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
 admin_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, created_at DESC);
`;

async function initDb() {
  await pool.query(schema);
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (email && password) {
    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(password, 12);
      const ref = "EAR" + crypto.randomBytes(4).toString("hex").toUpperCase();
      await pool.query(
        "INSERT INTO users(email,password_hash,display_name,role,referral_code) VALUES($1,$2,$3,'admin',$4)",
        [email, hash, "EARNOVA Admin", ref]
      );
      console.log("Initial admin account created.");
    }
  }
}

function makeCode(prefix = "EAR") {
  return prefix + "-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}
function safeUser(row) {
  return {
    id: row.id, email: row.email, name: row.display_name, role: row.role,
    balancePhp: Number(row.balance_php), referralCode: row.referral_code
  };
}
async function currentUser(req) {
  if (!req.session.userId) return null;
  const result = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  return result.rows[0] || null;
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}
async function requireAdmin(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
    if (user.is_banned) return res.status(403).json({ error: "Account disabled." });
    req.user = user;
    next();
  } catch (e) { next(e); }
}
async function ensureActive(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please log in." });
    if (user.is_banned) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Your account is suspended. Contact support." });
    }
    req.user = user;
    next();
  } catch (e) { next(e); }
}
function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, app: "EARNOVA" }); }
  catch { res.status(503).json({ ok: false }); }
});
app.get("/api/config", (req, res) => res.json({
  taskRewardPhp: TASK_REWARD_PHP,
  minWithdrawalPhp: MIN_WITHDRAWAL_PHP,
  referralBonusPhp: REFERRAL_BONUS_PHP
}));

app.post("/api/register", authLimiter, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const name = String(req.body.name || "").trim().slice(0, 60);
  const activationCode = String(req.body.activationCode || "").trim().toUpperCase();
  const referralCode = String(req.body.referralCode || "").trim().toUpperCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: "Password must be 8–72 characters." });
  if (name.length < 2) return res.status(400).json({ error: "Enter your name (at least 2 characters)." });
  if (!activationCode) return res.status(400).json({ error: "An activation code is required." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = await client.query("SELECT * FROM activation_codes WHERE code=$1 AND used_by IS NULL FOR UPDATE", [activationCode]);
    if (!code.rowCount) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Invalid or already-used activation code." }); }
    const dup = await client.query("SELECT id FROM users WHERE email=$1", [email]);
    if (dup.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Email is already registered." }); }
    let referrer = null;
    if (referralCode) {
      const r = await client.query("SELECT id FROM users WHERE referral_code=$1 AND is_banned=false", [referralCode]);
      if (!r.rowCount) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Referral code not found." }); }
      referrer = r.rows[0].id;
    }
    const hash = await bcrypt.hash(password, 12);
    const ownRef = "EAR" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const inserted = await client.query(
      "INSERT INTO users(email,password_hash,display_name,referral_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [email, hash, name, ownRef, referrer]
    );
    await client.query("UPDATE activation_codes SET used_by=$1,used_at=NOW() WHERE code=$2", [inserted.rows[0].id, activationCode]);
    if (referrer && REFERRAL_BONUS_PHP > 0) {
      await client.query("UPDATE users SET balance_php=balance_php+$1 WHERE id=$2", [REFERRAL_BONUS_PHP, referrer]);
      await client.query("INSERT INTO transactions(user_id,kind,amount_php,description) VALUES($1,'referral',$2,'Referral registration bonus')", [referrer, REFERRAL_BONUS_PHP]);
    }
    await client.query("COMMIT");
    req.session.userId = inserted.rows[0].id;
    res.status(201).json({ user: safeUser(inserted.rows[0]) });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") return res.status(409).json({ error: "Email or referral code already exists." });
    next(e);
  } finally { client.release(); }
});

app.post("/api/login", authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
    if (user.is_banned) return res.status(403).json({ error: "This account is suspended." });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.json({ user: safeUser(user) });
    });
  } catch (e) { next(e); }
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", requireAuth, ensureActive, async (req, res) => res.json({ user: safeUser(req.user) }));

app.get("/api/dashboard", requireAuth, ensureActive, async (req, res, next) => {
  try {
    const [tx, wd, stats] = await Promise.all([
      pool.query("SELECT id,kind,amount_php,description,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20", [req.user.id]),
      pool.query("SELECT id,amount_php,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10", [req.user.id]),
      pool.query("SELECT COUNT(*)::int AS referrals FROM users WHERE referred_by=$1", [req.user.id])
    ]);
    res.json({ user: safeUser(req.user), transactions: tx.rows, withdrawals: wd.rows, referrals: stats.rows[0].referrals });
  } catch (e) { next(e); }
});

function makeTask() {
  const types = ["math", "numbers", "word"];
  const type = types[Math.floor(Math.random() * types.length)];
  let question, answer;
  if (type === "math") {
    const a = Math.floor(Math.random() * 20) + 2, b = Math.floor(Math.random() * 15) + 2;
    question = `What is ${a} + ${b}?`; answer = String(a + b);
  } else if (type === "numbers") {
    const start = Math.floor(Math.random() * 20) + 1, step = Math.floor(Math.random() * 8) + 2;
    question = `Complete the sequence: ${start}, ${start + step}, ${start + step * 2}, __`; answer = String(start + step * 3);
  } else {
    const words = ["BLUE", "NOVA", "EARN", "TASK", "STAR", "WAVE"];
    const word = words[Math.floor(Math.random() * words.length)];
    question = `Type this word exactly: ${word}`; answer = word;
  }
  return { type, question, answer };
}
app.post("/api/tasks/new", requireAuth, ensureActive, taskLimiter, async (req, res, next) => {
  try {
    const task = makeTask();
    const hash = crypto.createHash("sha256").update(task.answer.toLowerCase()).digest("hex");
    const saved = await pool.query(
      "INSERT INTO tasks(user_id,task_type,question,answer_hash,reward_php,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '5 minutes') RETURNING id,task_type,question,reward_php,expires_at",
      [req.user.id, task.type, task.question, hash, TASK_REWARD_PHP]
    );
    res.json({ task: saved.rows[0], cooldownSeconds: 0 });
  } catch (e) { next(e); }
});
app.post("/api/tasks/:id/answer", requireAuth, ensureActive, taskLimiter, async (req, res, next) => {
  const answer = String(req.body.answer || "").trim().toLowerCase();
  if (!answer || answer.length > 40) return res.status(400).json({ error: "Enter your answer." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE", [req.params.id, req.user.id]);
    if (!found.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Task not found." }); }
    const task = found.rows[0];
    if (task.completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This task was already submitted." }); }
    if (new Date(task.expires_at) < new Date()) { await client.query("ROLLBACK"); return res.status(410).json({ error: "Task expired. Start a new task." }); }
    const hash = crypto.createHash("sha256").update(answer).digest("hex");
    const valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(task.answer_hash));
    if (!valid) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Incorrect answer. No money was added." }); }
    await client.query("UPDATE tasks SET completed_at=NOW() WHERE id=$1", [task.id]);
    await client.query("UPDATE users SET balance_php=balance_php+$1 WHERE id=$2", [task.reward_php, req.user.id]);
    await client.query("INSERT INTO transactions(user_id,kind,amount_php,description) VALUES($1,'task',$2,$3)", [req.user.id, task.reward_php, `${task.task_type} task completed`]);
    const updated = await client.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
    await client.query("COMMIT");
    res.json({ message: "Correct! ₱3.00 added to your wallet.", earnedPhp: Number(task.reward_php), user: safeUser(updated.rows[0]) });
  } catch (e) { await client.query("ROLLBACK"); next(e); }
  finally { client.release(); }
});

app.post("/api/withdrawals", requireAuth, ensureActive, async (req, res, next) => {
  const amountPHP = Number(req.body.amountPHP);
  const method = String(req.body.method || "");
  const accountName = String(req.body.accountName || "").trim().slice(0, 80);
  const accountNumber = String(req.body.accountNumber || "").trim().slice(0, 40);
  if (!Number.isFinite(amountPHP) || amountPHP < MIN_WITHDRAWAL_PHP || amountPHP > 1000000 || Math.round(amountPHP * 100) !== amountPHP * 100)
    return res.status(400).json({ error: `Minimum withdrawal is ₱${MIN_WITHDRAWAL_PHP.toFixed(2)}.` });
  if (!["GCash", "Maya"].includes(method)) return res.status(400).json({ error: "Choose GCash or Maya." });
  if (accountName.length < 2 || accountNumber.length < 6) return res.status(400).json({ error: "Enter valid account details." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT balance_php FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
    if (Number(u.rows[0].balance_php) < amountPHP) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Insufficient wallet balance." }); }
    await client.query("UPDATE users SET balance_php=balance_php-$1 WHERE id=$2", [amountPHP, req.user.id]);
    const wd = await client.query(
      "INSERT INTO withdrawals(user_id,amount_php,method,account_name,account_number) VALUES($1,$2,$3,$4,$5) RETURNING id,status,amount_php",
      [req.user.id, amountPHP, method, accountName, accountNumber]
    );
    await client.query("INSERT INTO transactions(user_id,kind,amount_php,description) VALUES($1,'withdrawal',$2,$3)", [req.user.id, -amountPHP, `Withdrawal request #${wd.rows[0].id} (${method})`]);
    await client.query("COMMIT");
    res.status(201).json({ withdrawal: wd.rows[0], message: "Request submitted for admin review." });
  } catch (e) { await client.query("ROLLBACK"); next(e); }
  finally { client.release(); }
});

app.get("/api/admin/overview", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [users, withdrawals, codes] = await Promise.all([
      pool.query("SELECT id,email,display_name,balance_php,is_banned,created_at FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 100"),
      pool.query("SELECT w.*,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.created_at DESC LIMIT 100"),
      pool.query("SELECT COUNT(*)::int AS unused FROM activation_codes WHERE used_by IS NULL")
    ]);
    res.json({ users: users.rows, withdrawals: withdrawals.rows, unusedCodes: codes.rows[0].unused });
  } catch (e) { next(e); }
});
app.post("/api/admin/codes", requireAuth, requireAdmin, async (req, res, next) => {
  const count = Math.min(50, Math.max(1, Math.floor(Number(req.body.count || 1))));
  try {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = makeCode();
      await pool.query("INSERT INTO activation_codes(code,created_by) VALUES($1,$2)", [code, req.user.id]);
      codes.push(code);
    }
    res.status(201).json({ codes });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/ban", requireAuth, requireAdmin, async (req, res, next) => {
  const reason = String(req.body.reason || "Policy violation").trim().slice(0, 200);
  try {
    const result = await pool.query("UPDATE users SET is_banned=true,ban_reason=$1 WHERE id=$2 AND role='user' RETURNING id", [reason, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/unban", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query("UPDATE users SET is_banned=false,ban_reason=NULL WHERE id=$1 AND role='user' RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/withdrawals/:id/review", requireAuth, requireAdmin, async (req, res, next) => {
  const status = String(req.body.status || "");
  const note = String(req.body.note || "").trim().slice(0, 200);
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid review status." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!found.rowCount || found.rows[0].status !== "pending") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Pending withdrawal not found." }); }
    const wd = found.rows[0];
    await client.query("UPDATE withdrawals SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3", [status, note, wd.id]);
    if (status === "rejected") {
      await client.query("UPDATE users SET balance_php=balance_php+$1 WHERE id=$2", [wd.amount_php, wd.user_id]);
      await client.query("INSERT INTO transactions(user_id,kind,amount_php,description) VALUES($1,'refund',$2,$3)", [wd.user_id, wd.amount_php, `Refund for rejected withdrawal #${wd.id}`]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, status });
  } catch (e) { await client.query("ROLLBACK"); next(e); }
  finally { client.release(); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`EARNOVA running on port ${PORT}`));
}).catch(err => { console.error("Startup failed:", err); process.exit(1); });
