// src/routes/walletWithdrawals.js
const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const { ensureAuth,requireAdmin } = require("../middlewares/auth");
const pool = require("../config/db");

// -------- helpers --------
function parseIntSafe(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function toDateEnd(d) {
  return d ? d + " 23:59:59" : null;
}


// -------- create (reserve funds immediately) --------
router.post(
  "/",
  ensureAuth,
  body("amount").isFloat({ gt: 0 }),
  body("method").isIn(["bank", "gada_token"]),
  body("transferTo").trim().isLength({ min: 3 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // ------------- Withdrawal Date Validation -------------
    const now = new Date();
    const currentDay = now.getDate(); // 1-31
    const currentMonth = now.getMonth() + 1; // 1-12
    const currentYear = now.getFullYear();

    // Check if current date is between 25th and 30th
    const isWithdrawalPeriod = currentDay >= 25 && currentDay <= 30;

    if (!isWithdrawalPeriod) {
      // Calculate next withdrawal period
      let nextMonth = currentMonth;
      let nextYear = currentYear;
      
      if (currentDay > 30) {
        // If we're past 30th, next period is 25th of next month
        nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
        nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
      }

      const nextWithdrawalStart = new Date(nextYear, nextMonth - 1, 25);
      const nextWithdrawalEnd = new Date(nextYear, nextMonth - 1, 30);

      const formatDate = (date) => {
        return date.toLocaleDateString('en-US', { 
          month: 'long', 
          day: 'numeric', 
          year: 'numeric' 
        });
      };

      return res.status(403).json({
        error: "Withdrawal portal is closed",
        message: "The withdrawal portal opens every 25th to 30th of every month.",
        nextWithdrawalPeriod: {
          start: formatDate(nextWithdrawalStart),
          end: formatDate(nextWithdrawalEnd)
        },
        currentDate: formatDate(now)
      });
    }

    const userId = Number(req.user.userId);
    const { amount, method, transferTo } = req.body;
    const amt = Number(amount);
    const MIN_WITHDRAW = 10000;
    
    if (amt < MIN_WITHDRAW) {
      return res.status(400).json({ error: `Minimum withdrawal is ₦${MIN_WITHDRAW}` });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [u] = await conn.query(
        "SELECT user_wallet_balance FROM users WHERE user_id = ? FOR UPDATE",
        [userId]
      );
      const balance = Number(u[0]?.user_wallet_balance ?? 0);
      
      if (amt > balance) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: "Insufficient balance" });
      }

      await conn.query(
        "UPDATE users SET user_wallet_balance = user_wallet_balance - ? WHERE user_id = ?",
        [amt, userId]
      );

      const [r] = await conn.query(
        `INSERT INTO wallet_payments
           (user_id, amount, method, method_value, time, status)
         VALUES (?, ?, ?, ?, NOW(), 0)`,
        [userId, String(amt), method, transferTo]
      );

      await conn.commit();
      res.json({ ok: true, id: r.insertId });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error(e);
      res.status(500).json({ error: "Failed to create withdrawal request" });
    } finally {
      conn.release();
    }
  }
);




// -------- ADMIN list (all users; default pending) --------
router.get("/admin", ensureAuth, requireAdmin,async (req, res) => {
//   if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  const page = parseIntSafe(req.query.page, 1);
  const pageSize = parseIntSafe(req.query.pageSize, 10);
  const startDate = req.query.startDate || null;
  const endDate   = req.query.endDate || null;
  const status    = req.query.status ?? "0"; // default pending
  const method    = req.query.method || "all";
  const q         = (req.query.q || "").trim();

  const where = [];
  const params = [];

  // Only our methods
  if (method !== "all") {
    where.push("wp.method = ?");
    params.push(method);
  } else {
    where.push("wp.method IN ('bank','gada_token')");
  }

  if (status !== "all") {
    const st = Number(status);
    if ([-1, 0, 1].includes(st)) {
      where.push("wp.status = ?");
      params.push(st);
    }
  }

  if (startDate) { where.push("wp.time >= ?"); params.push(startDate + " 00:00:00"); }
  if (endDate)   { where.push("wp.time <= ?"); params.push(toDateEnd(endDate)); }

  if (q) {
    where.push("(u.user_name LIKE ? OR wp.method_value LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [[{ cnt: total }]] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM wallet_payments wp
       JOIN users u ON u.user_id = wp.user_id
       ${whereSql}`,
      params
    );
    const offset = (page - 1) * pageSize;

    const [rows] = await pool.query(
      `SELECT
         wp.payment_id AS id,
         wp.user_id,
         u.user_name,
         wp.amount,
         wp.method,
         wp.method_value AS transferTo,
         wp.time,
         wp.status
       FROM wallet_payments wp
       JOIN users u ON u.user_id = wp.user_id
       ${whereSql}
       ORDER BY wp.payment_id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    res.json({
      items: rows,
      total,
      totalPages,
      page,
      limit: pageSize,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch withdrawal requests" });
  }
});

router.post("/:id/cancel", ensureAuth,requireAdmin, async (req, res) => {
//   if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  const userId = Number(req.user.userId);
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT payment_id, status,amount FROM wallet_payments WHERE payment_id = ? FOR UPDATE",
      [id]
    );
    const row = rows[0];
    if (!row) throw new Error("Not found");
    if (row.status !== 0) throw new Error("Already processed");

    await conn.query("UPDATE wallet_payments SET status = 2 WHERE payment_id = ?", [id]);

     const [u] = await conn.query(
        "SELECT user_wallet_balance FROM users WHERE user_id = ? FOR UPDATE",
        [userId]
      );
      const balance = Number(u[0]?.user_wallet_balance ?? 0);
      const amt = Number(row.amount);

      await conn.query(
        "UPDATE users SET user_wallet_balance = user_wallet_balance + ? WHERE user_id = ?",
        [amt, userId]
      );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error(e);
    res.status(400).json({ error: e.message || "Failed to cancel" });
  } finally {
    conn.release();
  }
});

// -------- Approve (mark approved only) --------
router.post("/:id/approve", ensureAuth,requireAdmin, async (req, res) => {
//   if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT payment_id, status FROM wallet_payments WHERE payment_id = ? FOR UPDATE",
      [id]
    );
    const row = rows[0];
    if (!row) throw new Error("Not found");
    if (row.status !== 0) throw new Error("Already processed");

    await conn.query("UPDATE wallet_payments SET status = 1 WHERE payment_id = ?", [id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error(e);
    res.status(400).json({ error: e.message || "Failed to approve" });
  } finally {
    conn.release();
  }
});

// -------- Decline (refund, then mark declined) --------
router.post("/:id/decline", ensureAuth,requireAdmin, async (req, res) => {
//   if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT user_id, amount, status FROM wallet_payments WHERE payment_id = ? FOR UPDATE",
      [id]
    );
    const row = rows[0];
    if (!row) throw new Error("Not found");
    if (row.status !== 0) throw new Error("Already processed");

    const amt = Number(row.amount);
    const userId = Number(row.user_id);

    await conn.query(
      "UPDATE users SET user_wallet_balance = user_wallet_balance + ? WHERE user_id = ?",
      [amt, userId]
    );
    await conn.query("UPDATE wallet_payments SET status = -1 WHERE payment_id = ?", [id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error(e);
    res.status(500).json({ error: "Failed to decline" });
  } finally {
    conn.release();
  }
});


// -------- user list (current user) --------
router.get("/", ensureAuth, async (req, res) => {
    const userId = Number(req.user.userId);
    // optional filters for the user list (kept compatible)
    const page = parseIntSafe(req.query.page, 1);
    const pageSize = parseIntSafe(req.query.pageSize, 50);
    const startDate = req.query.startDate || null;
    const endDate   = req.query.endDate || null;
    const status    = req.query.status; // all | -1 | 0 | 1
    const method    = req.query.method; // all | bank | gada_token
    const q         = (req.query.q || "").trim();
  
    const where = ["wp.user_id = ?"];
    const params = [userId];
  
    if (method && method !== "all") {
      where.push("wp.method = ?");
      params.push(method);
    } else {
      where.push("wp.method IN ('bank','gada_token')");
    }
    if (status && status !== "all") {
      const st = Number(status);
      if ([-1, 0, 1].includes(st)) {
        where.push("wp.status = ?");
        params.push(st);
      }
    }
    if (startDate) { where.push("wp.time >= ?"); params.push(startDate + " 00:00:00"); }
    if (endDate)   { where.push("wp.time <= ?"); params.push(toDateEnd(endDate)); }
    if (q) { where.push("wp.method_value LIKE ?"); params.push(`%${q}%`); }
  
    const whereSql = `WHERE ${where.join(" AND ")}`;
  
    try {
      const [[{ cnt: total }]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM wallet_payments wp ${whereSql}`,
        params
      );
      const offset = (page - 1) * pageSize;
  
      const [rows] = await pool.query(
        `SELECT wp.payment_id AS id, wp.amount, wp.method, wp.method_value AS transferTo, wp.time, wp.status
         FROM wallet_payments wp
         ${whereSql}
         ORDER BY wp.payment_id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
  
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      res.json({
        data: rows,
        page,
        pageSize,
        total,
        totalPages,
        hasMore: page < totalPages,
        nextPage: page < totalPages ? page + 1 : null,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch withdrawals" });
    }
  });
module.exports = router;
