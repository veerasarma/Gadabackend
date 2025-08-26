// src/routes/adminPointsSettings.js
const express = require("express");
const pool = require("../../config/db");
const { ensureAuth, requireAdmin } = require("../../middlewares/auth");
const { body, validationResult } = require("express-validator");

const router = express.Router();

// All option keys we support on this page
const KEYS = [
  "points_enabled",
  "points_limit_pro",
  "points_limit_user",
  "points_min_withdrawal",
  "points_money_transfer_enabled",
  "points_per_comment",
  "points_per_currency",
  "points_per_follow",
  "points_per_post",
  "points_per_post_comment",
  "points_per_post_reaction",
  "points_per_post_view",
  "points_per_reaction",
];

// Default values if an option is not set yet
const DEFAULTS = {
  points_enabled: "0",
  points_limit_pro: "0",
  points_limit_user: "0",
  points_min_withdrawal: "0",
  points_money_transfer_enabled: "0",
  points_per_comment: "0",
  points_per_currency: "0",
  points_per_follow: "0",
  points_per_post: "0",
  points_per_post_comment: "0",
  points_per_post_reaction: "0",
  points_per_post_view: "0",
  points_per_reaction: "0",
};

const BOOLS = new Set(["points_enabled", "points_money_transfer_enabled"]);

const asBool = (v) => v === "1" || v === 1 || v === true || String(v).toLowerCase() === "true";

// ---------- GET: read all  ----------
router.get("/fetch", ensureAuth, requireAdmin, async (_req, res) => {
  try {
    const placeholders = KEYS.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT option_name, option_value FROM system_options WHERE option_name IN (${placeholders})`,
      KEYS
    );
    const map = Object.fromEntries(rows.map((r) => [r.option_name, r.option_value]));
    // fill defaults, cast types
    const out = {};
    for (const k of KEYS) {
      const raw = map[k] ?? DEFAULTS[k];
      out[k] = BOOLS.has(k) ? asBool(raw) : Number(raw || 0);
    }
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to load points settings" });
  }
});

// ---------- PUT: save all ----------
router.put(
  "/update",
  ensureAuth,
  requireAdmin,
  // validation
  [
    body("points_enabled").isBoolean(),
    body("points_money_transfer_enabled").isBoolean(),

    body("points_limit_pro").isFloat({ min: 0 }),
    body("points_limit_user").isFloat({ min: 0 }),
    body("points_min_withdrawal").isFloat({ min: 0 }),

    body("points_per_comment").isFloat({ min: 0 }),
    body("points_per_currency").isFloat({ min: 0 }),
    body("points_per_follow").isFloat({ min: 0 }),
    body("points_per_post").isFloat({ min: 0 }),
    body("points_per_post_comment").isFloat({ min: 0 }),
    body("points_per_post_reaction").isFloat({ min: 0 }),
    body("points_per_post_view").isFloat({ min: 0 }),
    body("points_per_reaction").isFloat({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      // Build rows for upsert
      const values = KEYS.map((k) => {
        const v = req.body[k];
        // booleans -> "1"/"0", numbers -> string
        const val = BOOLS.has(k) ? (asBool(v) ? "1" : "0") : String(Number(v || 0));
        return [k, val];
      });

      // Bulk upsert
      const sql =
        "INSERT INTO system_options (option_name, option_value) VALUES ? " +
        "ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)";
      await pool.query(sql, [values]);

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to save points settings" });
    }
  }
);

module.exports = router;
