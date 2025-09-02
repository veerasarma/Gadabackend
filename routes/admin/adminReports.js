// routes/adminReports.js
const express = require("express");
const router = express.Router();

const pool = require("../../config/db");            // <- your existing MySQL pool
const { requireAdmin } = require("../../middlewares/auth"); // <- same admin guard you use elsewhere

// Utility: build WHERE clauses for search safely
function buildSearch(q) {
  if (!q) return { sql: "", params: [] };
  const like = `%${q}%`;
  // We attempt to cover common columns (category title/name, user name, node type, free text)
  return {
    sql: `
      AND (
            COALESCE(c.title, c.name, c.category_name, '') LIKE ?
         OR u.user_name LIKE ?
         OR u.user_firstname LIKE ?
         OR u.user_lastname LIKE ?
         OR r.node_type LIKE ?
         OR r.text LIKE ?
      )
    `,
    params: [like, like, like, like, like, like],
  };
}

// GET /api/admin/reports?limit=10&page=1&q=
router.get("/", requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
    const page  = Math.max(1, Number(req.query.page) || 1);
    const q     = String(req.query.q || "").trim();

    const { sql: whereSearch, params: searchParams } = buildSearch(q);

    // total count
    const [cntRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM reports r
      LEFT JOIN users u ON u.user_id = r.user_id
      LEFT JOIN reports_categories c ON c.category_id = r.category_id
      WHERE 1=1
        ${whereSearch}
      `,
      searchParams
    );
    const total = Number(cntRows[0]?.total || 0);
    const pages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;

    // page rows
    const [rows] = await pool.query(
      `
      SELECT
        r.report_id           AS id,
        r.node_id,
        r.node_type,
        r.category_id          AS category_id,
        COALESCE( c.category_name) AS category,
        r.reason                AS reason_text,
        r.user_id             AS reporter_id,
        u.user_name           AS reporter_username,
        TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)) AS reporter_fullname,
        u.user_picture        AS reporter_avatar,
        r.time                AS created_at
      FROM reports r
      LEFT JOIN users u ON u.user_id = r.user_id
      LEFT JOIN reports_categories c ON c.category_id = r.category_id
      WHERE 1=1
        ${whereSearch}
      ORDER BY r.report_id DESC
      LIMIT ? OFFSET ?
      `,
      [...searchParams, limit, offset]
    );

    res.json({
      ok: true,
      page,
      pages,
      total,
      items: rows.map(r => ({
        id: r.id,
        nodeId: r.node_id,
        type: r.node_type,                     // "post" etc.
        category: r.category || "—",
        reason: r.reason_text || "",
        reporter: {
          id: r.reporter_id,
          username: r.reporter_username,
          fullName: r.reporter_fullname || r.reporter_username || "",
          avatar: r.reporter_avatar || null,
        },
        time: r.created_at,
      })),
    });
  } catch (e) {
    console.error("[admin reports] list error:", e);
    res.status(500).json({ ok: false, error: "Failed to load reports" });
  }
});

// Optional: bulk mark-all-as-safe (deletes all)
router.post("/bulk/mark-safe", requireAdmin, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (ids.length === 0) {
        // if no ids sent, clear everything (like your "Mark All As Safe" button in screenshot)
        await pool.query("TRUNCATE TABLE reports");
        return res.json({ ok: true, clearedAll: true });
      }
      const [r] = await pool.query(
        `DELETE FROM reports WHERE report_id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
      res.json({ ok: true, affected: r.affectedRows || 0 });
    } catch (e) {
      console.error("[admin reports] bulk mark-safe error:", e);
      res.status(500).json({ ok: false, error: "Failed to mark selected as safe" });
    }
  });
  

// POST /api/admin/reports/:id/mark-safe  -> simply delete the row
router.post("/:id/mark-safe", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [r] = await pool.query(
      "DELETE FROM reports WHERE report_id = ? LIMIT 1",
      [id]
    );
    if (!r.affectedRows) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[admin reports] mark-safe error:", e);
    res.status(500).json({ ok: false, error: "Failed to mark as safe" });
  }
});

// DELETE /api/admin/reports/:id  -> delete the row as well
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [r] = await pool.query(
      "DELETE FROM reports WHERE report_id = ? LIMIT 1",
      [id]
    );
    if (!r.affectedRows) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[admin reports] delete error:", e);
    res.status(500).json({ ok: false, error: "Failed to delete report" });
  }
});


module.exports = router;
