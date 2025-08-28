// src/routes/adminSubscribers.js
const express = require("express");
const pool = require("../../config/db");
const { ensureAuth, requireAdmin } = require("../../middlewares/auth");

const router = express.Router();

// Helper: safe ints
const i = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

/**
 * GET /api/admin/subscribers
 * Query:
 *  - page, pageSize
 *  - search (user name / handle)
 *  - status: active | expired | all (default: all)
 *  - packageName (optional exact)
 *  - order: newest | oldest (by subscription time)
 *  - export: csv (optional) -> returns CSV file
 *
 * Output:
 *  {
 *    items: [{ userId, user, handle, packageName, packageId, price, time, subscription, expiration, remainingDays, status }],
 *    page, pageSize, total, totalPages
 *  }
 */
router.get("/", ensureAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, i(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(1, i(req.query.pageSize, 10)));
  const search = (req.query.search || "").trim();
  const status = (req.query.status || "all").toLowerCase(); // active|expired|all
  const packageName = (req.query.packageName || "").trim();
  const order = (req.query.order || "newest") === "oldest" ? "ASC" : "DESC";
  const wantCsv = (req.query.export || "").toLowerCase() === "csv";

  // NOTE:
  // - latest payment per user
  // - join to packages by package_name to pick period/length
  // - compute expiration via CASE + DATE_ADD
  // - compute remaining days and status in SQL
  const baseSql = `
    SELECT
      l.user_id            AS userId,
      COALESCE(u.user_name, u.user_firstname, u.user_lastname) AS user,
      COALESCE(u.user_name, u.user_firstname, u.user_lastname)   AS handle,
      l.package_name       AS packageName,
      p.package_id         AS packageId,
      l.package_price      AS price,
      l.payment_date       AS time,
      DATE_FORMAT(l.payment_date, '%Y-%m-%d %H:%i:%s')         AS subscription,
      CASE p.period
        WHEN 'day'   THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
        WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH)
        WHEN 'year'  THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR)
        ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
      END                                                     AS expiration_dt,
      DATE_FORMAT(
        CASE p.period
          WHEN 'day'   THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
          WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH)
          WHEN 'year'  THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR)
          ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
        END,
      '%Y-%m-%d %H:%i:%s')                                    AS expiration,
      DATEDIFF(
        CASE p.period
          WHEN 'day'   THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
          WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH)
          WHEN 'year'  THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR)
          ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
        END,
        CURDATE()
      )                                                       AS remainingDays,
      CASE
        WHEN DATEDIFF(
          CASE p.period
            WHEN 'day'   THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
            WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH)
            WHEN 'year'  THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR)
            ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY)
          END,
          CURDATE()
        ) >= 0 THEN 'Active' ELSE 'Expired'
      END                                                     AS status
    FROM (
      SELECT pp.*
      FROM packages_payments pp
      INNER JOIN (
        SELECT user_id, MAX(payment_date) AS max_dt
        FROM packages_payments
        GROUP BY user_id
      ) m ON m.user_id = pp.user_id AND m.max_dt = pp.payment_date
    ) l
    LEFT JOIN packages p ON p.name = l.package_name
    LEFT JOIN users u     ON u.user_id = l.user_id
  `;

  // Filters
  const where = [];
  const params = [];

  if (search) {
    where.push("(COALESCE(u.user_name, u.name, u.full_name, u.username) LIKE ? OR COALESCE(u.username, u.user_username, u.user_handle) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (packageName) {
    where.push("l.package_name = ?");
    params.push(packageName);
  }
  if (status === "active")   where.push("DATEDIFF(CASE p.period WHEN 'day' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY) WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH) WHEN 'year' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR) ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY) END, CURDATE()) >= 0");
  if (status === "expired")  where.push("DATEDIFF(CASE p.period WHEN 'day' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num DAY) WHEN 'month' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num MONTH) WHEN 'year' THEN DATE_ADD(l.payment_date, INTERVAL p.period_num YEAR) ELSE DATE_ADD(l.payment_date, INTERVAL p.period_num DAY) END, CURDATE()) < 0");

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    // total count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM (${baseSql} ${whereSql}) AS T`,
      params
    );
    const total = Number(countRows[0]?.cnt || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    // page rows
    const [rows] = await pool.query(
      `${baseSql} ${whereSql} ORDER BY time ${order} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    if (wantCsv) {
      // CSV export
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="subscribers_${Date.now()}.csv"`);
      const header = [
        "User ID","User","Handle","Package","Price","Subscribed At","Expiration","Remaining Days","Status"
      ];
      const lines = [header.join(",")];
      for (const r of rows) {
        const line = [
          r.userId, safeCsv(r.user), safeCsv(r.handle), safeCsv(r.packageName),
          r.price, r.subscription, r.expiration, r.remainingDays, r.status
        ].join(",");
        lines.push(line);
      }
      return res.send(lines.join("\n"));
    }

    res.json({
      items: rows,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load subscribers" });
  }
});

function safeCsv(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

module.exports = router;
