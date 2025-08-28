// src/routes/adminPackagesEarnings.js
const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const { ensureAuth, requireAdmin } = require("../../middlewares/auth");

// Helper
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// ===== Monthly + totals (for chart & cards) =====
// GET /api/admin/earnings/packages/summary?year=2025&month=8
router.get("/summary", ensureAuth, requireAdmin, async (req, res) => {
  const year = int(req.query.year, new Date().getFullYear());
  const month = req.query.month ? int(req.query.month, null) : null;

  try {
    // 1) Monthly sums per package (for chart)
    const [monthlyRows] = await pool.query(
      `SELECT package_name, MONTH(payment_date) AS m, SUM(package_price) AS total
         FROM packages_payments
        WHERE YEAR(payment_date) = ?
        GROUP BY package_name, MONTH(payment_date)
        ORDER BY package_name, m`,
      [year]
    );

    // Build series: [{ package_name, data:[m1..m12] }]
    const byPkg = new Map();
    for (const r of monthlyRows) {
      const key = r.package_name;
      if (!byPkg.has(key)) byPkg.set(key, Array(12).fill(0));
      byPkg.get(key)[r.m - 1] = Number(r.total || 0);
    }
    const series = [...byPkg.entries()].map(([package_name, data]) => ({ package_name, data }));

    // 2) All-time total earnings
    const [[{ total_all = 0 } = {}]] = await pool.query(
      `SELECT COALESCE(SUM(package_price),0) AS total_all FROM packages_payments`
    );

    // 3) This-month earnings (or selected month of year)
    let params = [];
    let whereMonth = `YEAR(payment_date) = ? AND MONTH(payment_date) = ?`;
    if (month == null) {
      const now = new Date();
      params = [now.getFullYear(), now.getMonth() + 1];
    } else {
      params = [year, month];
    }
    const [[{ total_month = 0 } = {}]] = await pool.query(
      `SELECT COALESCE(SUM(package_price),0) AS total_month
         FROM packages_payments
        WHERE ${whereMonth}`,
      params
    );

    res.json({
      year,
      series,            // [{ package_name, data:[12 values]}]
      totalAll: Number(total_all || 0),
      totalThisMonth: Number(total_month || 0),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load packages earnings summary" });
  }
});

// ===== Table (paged, searchable) =====
// GET /api/admin/earnings/packages/table?search=&page=1&pageSize=10&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&sort=earnings&order=desc
router.get("/table", ensureAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, int(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(1, int(req.query.pageSize, 10)));
  const search = (req.query.search || "").trim();
  const startDate = req.query.startDate || null; // YYYY-MM-DD
  const endDate = req.query.endDate || null;     // YYYY-MM-DD
  const sort = (req.query.sort || "earnings").toLowerCase(); // name|sales|earnings
  const order = (req.query.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  // Build LEFT JOIN with date conditions in the ON clause so packages with zero rows still appear
  const onConds = ["pp.package_name = p.name"];
  const onParams = [];
  if (startDate) { onConds.push("pp.payment_date >= ?"); onParams.push(`${startDate} 00:00:00`); }
  if (endDate) { onConds.push("pp.payment_date <= ?"); onParams.push(`${endDate} 23:59:59`); }
  const onSql = onConds.join(" AND ");

  const whereConds = [];
  const whereParams = [];
  if (search) { whereConds.push("p.name LIKE ?"); whereParams.push(`%${search}%`); }
  const whereSql = whereConds.length ? `WHERE ${whereConds.join(" AND ")}` : "";

  // Sorting
  let orderSql = "ORDER BY total_earnings DESC";
  if (sort === "name") orderSql = `ORDER BY p.name ${order}`;
  if (sort === "sales") orderSql = `ORDER BY total_sales ${order}`;
  if (sort === "earnings") orderSql = `ORDER BY total_earnings ${order}`;

  try {
    // Count packages (search only)
    const [[{ cnt = 0 } = {}]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM packages p ${whereSql}`,
      whereParams
    );
    const total = Number(cnt);

    const offset = (page - 1) * pageSize;

    // Data rows
    const [rows] = await pool.query(
      `SELECT
          p.package_id,
          p.name AS package,
          COALESCE(COUNT(pp.payment_id), 0) AS total_sales,
          COALESCE(SUM(pp.package_price), 0) AS total_earnings
         FROM packages p
         LEFT JOIN packages_payments pp
           ON ${onSql}
        ${whereSql}
        GROUP BY p.package_id, p.name
        ${orderSql}
        LIMIT ? OFFSET ?`,
      [...onParams, ...whereParams, pageSize, offset]
    );

    res.json({
      items: rows.map(r => ({
        package_id: r.package_id,
        package: r.package,
        total_sales: Number(r.total_sales || 0),
        total_earnings: Number(r.total_earnings || 0),
      })),
      page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load packages table" });
  }
});

module.exports = router;
