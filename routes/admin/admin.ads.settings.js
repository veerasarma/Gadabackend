const express = require("express");
const router = express.Router();
const pool  = require("../../config/db"); // adjust
const { ensureAuth, requireAdmin } = require("../../middlewares/auth");

// Option keys we care about
const KEYS = [
  "ads_enabled",
  "ads_approval_enabled",
  "ads_author_view_enabled",
  "ads_cost_view",
  "ads_cost_click",
];

// GET /api/admin/ads/settings
router.get("/", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT option_name, option_value FROM system_options WHERE option_name IN (?)",
      [KEYS]
    );
    const map = {};
    for (const k of KEYS) {
      const found = rows.find((r) => r.option_name === k);
      map[k] = found ? found.option_value : null;
    }
    res.json({ ok: true, settings: map });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to load settings" });
  }
});

// POST /api/admin/ads/settings
router.post("/", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const k of KEYS) {
        if (updates[k] === undefined) continue;
        await conn.query(
          `INSERT INTO system_options (option_name, option_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE option_value=VALUES(option_value)`,
          [k, String(updates[k])]
        );
      }
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to save settings" });
  }
});

module.exports = router;
