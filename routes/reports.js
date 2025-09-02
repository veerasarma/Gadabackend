const express = require('express');
const router = express.Router();
const pool = require('../config/db');                  // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth'); 

/**
 * Mount like:
 *   const reportsRouter = require("./routes/reports")(pool, ensureAuth);
 *   app.use("/api/reports", reportsRouter);
 */
  // GET /api/reports/categories
  router.get("/categories", ensureAuth, async (_req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT category_id, category_parent_id, category_name, category_description, category_order
           FROM reports_categories
          ORDER BY category_order ASC, category_id ASC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "Failed to load categories" });
    }
  });

  // POST /api/reports   { nodeId, nodeType:'post', categoryId, reason? }
  router.post("/", ensureAuth, async (req, res) => {
    const userId = Number(req.user.userId);
    const nodeId = Number(req.body?.nodeId);
    const nodeType = String(req.body?.nodeType || "post").trim().toLowerCase();
    const categoryId = Number(req.body?.categoryId || 0);
    const reason = String(req.body?.reason || "").trim();

    if (!nodeId || !categoryId) {
      return res.status(400).json({ ok: false, error: "nodeId and categoryId are required" });
    }

    // Limit to post for now; extend as needed
    if (!["post"].includes(nodeType)) {
      return res.status(400).json({ ok: false, error: "Unsupported nodeType" });
    }

    try {
      // (Optional) prevent spam: dedupe same (user, node, category) in last 24h
      const [dupe] = await pool.query(
        `SELECT report_id
           FROM reports
          WHERE user_id = ? AND node_id = ? AND node_type = ? AND category_id = ?
            AND time >= (NOW() - INTERVAL 1 DAY)
          LIMIT 1`,
        [userId, nodeId, nodeType, categoryId]
      );
      if (dupe.length) {
        return res.json({ ok: true, deduped: true });
      }

      await pool.query(
        `INSERT INTO reports (user_id, node_id, node_type, category_id, reason, time)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [userId, nodeId, nodeType, categoryId, reason]
      );

      // (Optional) notify mods here…

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "Failed to submit report" });
    }
  });


  module.exports = router;

