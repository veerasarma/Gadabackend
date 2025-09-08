const express = require("express");
const router = express.Router();
const  pool  = require("../../config/db"); // adjust path to your MySQL pool
const { ensureAuth, requireAdmin } = require("../../middlewares/auth"); // adjust

// Helpers
const parseIntSafe = (v, d) => (isNaN(parseInt(v)) ? d : parseInt(v));

/**
 * List user ads (admin)
 * GET /api/admin?status=pending|approved&search=&page=1&limit=10
 */
router.get("", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const status = (req.query.status || "pending").toLowerCase();
    const search = (req.query.search || "").trim();
    const page = Math.max(1, parseIntSafe(req.query.page, 1));
    const limit = Math.max(1, Math.min(100, parseIntSafe(req.query.limit, 10)));
    const offset = (page - 1) * limit;

    // Map status to flags in ads_campaigns
    const whereStatus =
      status === "approved"
        ? "ac.campaign_is_approved='1' AND ac.campaign_is_declined='0'"
        : "ac.campaign_is_approved='0' AND ac.campaign_is_declined='0'"; // pending

    const searchSql = search
      ? " AND (ac.campaign_title LIKE ? OR u.user_name LIKE ? OR u.user_email LIKE ?)"
      : "";
    const params = [];
    if (search) {
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    // Join to users for "By" column
    const base =
      ` FROM ads_campaigns ac
         LEFT JOIN users u ON u.user_id = ac.campaign_user_id
        WHERE ${whereStatus} ${searchSql}`;

    const [rows] = await pool.query(
      `SELECT ac.campaign_id, ac.campaign_title, ac.campaign_budget, ac.campaign_spend,
              ac.campaign_bidding, ac.campaign_clicks, ac.campaign_views,
              ac.campaign_is_active, ac.campaign_start_date, ac.campaign_end_date,
              ac.ads_placement, ac.campaign_created_date,
              u.user_id, u.user_name
       ${base}
       ORDER BY ac.campaign_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${base}`,
      params
    );

    res.json({ ok: true, items: rows, total, page, limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to load ads" });
  }
});

/**
 * Approve
 */
router.post("/:id/approve", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id, 0);
    const [r] = await pool.query(
      `UPDATE ads_campaigns
         SET campaign_is_approved='1', campaign_is_declined='0'
       WHERE campaign_id=?`,
      [id]
    );
    res.json({ ok: true, updated: r.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to approve" });
  }
});

/**
 * Decline
 */
router.post("/:id/decline", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id, 0);
    const [r] = await pool.query(
      `UPDATE ads_campaigns
         SET campaign_is_approved='0', campaign_is_declined='1', campaign_is_active='0'
       WHERE campaign_id=?`,
      [id]
    );
    res.json({ ok: true, updated: r.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to decline" });
  }
});

/**
 * Toggle Active (pause/resume)
 */
router.post("/:id/active", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id, 0);
    const nextActive = req.body.active ? "1" : "0";
    const [r] = await pool.query(
      `UPDATE ads_campaigns SET campaign_is_active=? WHERE campaign_id=?`,
      [nextActive, id]
    );
    res.json({ ok: true, active: nextActive === "1" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to update status" });
  }
});

/**
 * Delete (admin)
 */
router.delete("/:id", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id, 0);
    const [r] = await pool.query(
      `DELETE FROM ads_campaigns WHERE campaign_id=?`,
      [id]
    );
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to delete" });
  }
});

/**
 * One ad detail (optional "view" drawer)
 */
router.get("/:id", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id, 0);
    const [rows] = await pool.query(
      `SELECT ac.*, u.user_id, u.user_name, u.user_email
         FROM ads_campaigns ac
         LEFT JOIN users u ON u.user_id = ac.campaign_user_id
        WHERE ac.campaign_id=?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to fetch" });
  }
});

module.exports = router;
