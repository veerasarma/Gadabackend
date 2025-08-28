// routes/adminEarningPayments.js
const express = require("express");
const pool = require("../config/db");
const { ensureAuth, requireRole } = require("../middlewares/auth");

const router = express.Router();
router.use(ensureAuth, requireRole("admin"));

/**
 * GET /api/admin/earning-payments
 * Incoming earnings only (type = 'in')
 * Pagination only, no filters/search. Default limit=25.
 * Joins users to include user_name.
 */
router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 25);
    const offset = (page - 1) * limit;

    // Count only 'in' transactions
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM wallet_transactions wt
       WHERE wt.type = 'in'`
    );

    // Rows
    const [items] = await pool.query(
      `SELECT wt.transaction_id, wt.user_id, wt.node_type, wt.node_id, wt.amount,
              wt.reference, wt.type, wt.date,
              u.user_name
       FROM wallet_transactions wt
       LEFT JOIN users u ON wt.user_id = u.user_id
       WHERE wt.type = 'in'
       ORDER BY wt.date DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const totalPages = Math.max(1, Math.ceil(count / limit));

    res.json({
      items,
      total: count,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load earning payments" });
  }
});

router.get("/log-points-stats", async (req, res) => {
  try {
    // ---- From wallet_transactions ----
    const [rows1] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as totalPayIn FROM wallet_transactions WHERE type = 'in'"
    );
    const totalPayIn = rows1[0].totalPayIn;

    // total pay-in (last 30 days)
    const [rows2] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as totalPayInMonth FROM wallet_transactions WHERE type = 'in' AND date >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
    );
    const totalPayInMonth = rows2[0].totalPayInMonth;

    // total pay-out
    const [rows3] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as totalPayOut FROM wallet_transactions WHERE type = 'out'"
    );
    const totalPayOut = rows3[0].totalPayOut;

    // total pay-out (last 30 days)
    const [rows4] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as totalPayOutMonth FROM wallet_transactions WHERE type = 'out' AND date >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
    );
    const totalPayOutMonth = rows4[0].totalPayOutMonth;

    // ---- From wallet_payments ----
    // pending pay-out
    const [rows5] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as pendingPayOut FROM wallet_payments WHERE status = 0"
    );
    const pendingPayOut = rows5[0].pendingPayOut;

    // pending pay-out (last 30 days)
    const [rows6] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as pendingPayOutMonth FROM wallet_payments WHERE status = 0 AND time >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
    );
    const pendingPayOutMonth = rows6[0].pendingPayOutMonth;

    // ✅ Send response
    res.json({
      totalPayIn,
      totalPayInMonth,
      totalPayOut,
      totalPayOutMonth,
      pendingPayOut,
      pendingPayOutMonth,
    });
  } catch (err) {
    console.error("Error fetching wallet stats:", err);
    res.status(500).json({ error: "Failed to fetch wallet stats" });
  }
});

router.get("/payin-methods", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
         MONTH(time) as month,
         method,
         SUM(amount) as total
       FROM wallet_payments
       WHERE status = 1
         AND YEAR(time) = YEAR(CURDATE())
         AND method IN ('bank', 'paypal')   -- ✅ only bank & paypal
       GROUP BY MONTH(time), method
       ORDER BY MONTH(time)`
    );

    // only keep these 2 methods
    const methods = ["bank", "paypal"];

    // build full 12-month dataset
    const result = Array.from({ length: 12 }, (_, i) => {
      const monthIndex = i + 1;
      const monthName = new Date(0, monthIndex - 1).toLocaleString("default", {
        month: "short",
      });

      const obj = { month: monthName };
      methods.forEach((m) => {
        const row = rows.find((r) => r.month === monthIndex && r.method === m);
        obj[m] = row ? parseFloat(row.total) : 0;
      });
      return obj;
    });

    res.json({ methods, data: result });
  } catch (err) {
    console.error("Error fetching payin methods chart:", err);
    res.status(500).json({ error: "Failed to fetch payin methods chart" });
  }
});

module.exports = router;
