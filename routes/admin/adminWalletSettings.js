// src/routes/adminWalletSettings.js
const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const { ensureAuth, requireAdmin } = require("../../middlewares/auth"); // if you don't have requireAdmin, keep ensureAuth only
const { body, validationResult } = require("express-validator");

// Keys we manage in system_options
const KEYS = [
  "wallet_min_withdrawal",
  "wallet_max_transfer",
  "wallet_withdrawal_enabled",
];

// Helpers
const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const boolToStr = (b) => (b ? "1" : "0");

/**
 * GET /api/admin/wallet-settings
 * Returns:
 * {
 *   wallet_min_withdrawal: number|null,
 *   wallet_max_transfer: number|null,
 *   wallet_withdrawal_enabled: boolean
 * }
 */
router.get("/", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT option_name, option_value
         FROM system_options
        WHERE option_name IN (?, ?, ?)`,
      KEYS
    );

    const map = Object.fromEntries(rows.map((r) => [r.option_name, r.option_value]));

    const payload = {
      wallet_min_withdrawal: map.wallet_min_withdrawal != null ? Number(map.wallet_min_withdrawal) : null,
      wallet_max_transfer: map.wallet_max_transfer != null ? Number(map.wallet_max_transfer) : null,
      wallet_withdrawal_enabled: map.wallet_withdrawal_enabled === "1",
    };

    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load wallet settings" });
  }
});

/**
 * PUT /api/admin/wallet-settings
 * Body:
 * {
 *   wallet_min_withdrawal: number|null,
 *   wallet_max_transfer: number|null,
 *   wallet_withdrawal_enabled: boolean
 * }
 */
router.put(
  "/",
  ensureAuth,
  requireAdmin,
  body("wallet_min_withdrawal").optional({ nullable: true }).isFloat({ min: 0 }).withMessage("Must be >= 0"),
  body("wallet_max_transfer").optional({ nullable: true }).isFloat({ min: 0 }).withMessage("Must be >= 0"),
  body("wallet_withdrawal_enabled").isBoolean(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const minWithdrawal = numOrNull(req.body.wallet_min_withdrawal);
    const maxTransfer   = numOrNull(req.body.wallet_max_transfer);
    const enabled       = !!req.body.wallet_withdrawal_enabled;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const upsert = async (key, value) => {
        await conn.query(
          `INSERT INTO system_options (option_name, option_value)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)`,
          [key, value]
        );
      };

      await upsert("wallet_min_withdrawal", minWithdrawal === null ? "" : String(minWithdrawal));
      await upsert("wallet_max_transfer",   maxTransfer   === null ? "" : String(maxTransfer));
      await upsert("wallet_withdrawal_enabled", boolToStr(enabled));

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error(e);
      res.status(500).json({ error: "Failed to save wallet settings" });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
