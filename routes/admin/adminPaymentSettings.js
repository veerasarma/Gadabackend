// src/routes/adminPaymentSettings.js
const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();

const pool = require("../../config/db");
const { ensureAuth,requireAdmin } = require("../../middlewares/auth");

// ---- admin check helper ----


// ---- helpers ----
const ALLOWED_KEYS = new Set([
  "bank_transfers_enabled",
  "bank_name",
  "bank_account_number",
  "bank_account_name",
  "bank_account_country",
  "bank_transfer_note",

  "payment_fees_enabled",
  "payment_fees_percentage",

  "payment_vat_enabled",
  "payment_country_vat_enabled",
  "payment_vat_percentage",

  "paystack_enabled",
  "paystack_secret",
]);

function sanitizePairs(obj) {
  const pairs = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (ALLOWED_KEYS.has(k)) {
      // store booleans as "1"/"0" strings; numbers/strings as strings
      let val = v;
      if (typeof v === "boolean") val = v ? "1" : "0";
      if (typeof v === "number") val = String(v);
      if (v === null || v === undefined) val = "";
      pairs.push([k, String(val)]);
    }
  }
  return pairs;
}

// ---- GET all (or by list of keys) ----
//   /api/admin/payment-settings?keys=comma,separated,keys
router.get("/", ensureAuth, requireAdmin, async (req, res) => {
  const keysParam = (req.query.keys || "").trim();
  const wantKeys = keysParam
    ? keysParam.split(",").map((k) => k.trim()).filter(Boolean)
    : Array.from(ALLOWED_KEYS);

  // Filter to allowed keys only
  const keys = wantKeys.filter((k) => ALLOWED_KEYS.has(k));
  if (!keys.length) return res.json({ data: {} });

  try {
    const placeholders = keys.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT option_name, option_value FROM system_options WHERE option_name IN (${placeholders})`,
      keys
    );

    const out = {};
    for (const k of keys) out[k] = ""; // default empty
    for (const r of rows) out[r.option_name] = r.option_value ?? "";

    // booleans back to true/false; numbers back to number when obvious
    const result = { ...out };
    const bools = new Set([
      "bank_transfers_enabled",
      "payment_fees_enabled",
      "payment_vat_enabled",
      "payment_country_vat_enabled",
      "paystack_enabled",
    ]);
    const numbers = new Set([
      "payment_fees_percentage",
      "payment_vat_percentage",
    ]);
    for (const k of Object.keys(result)) {
      if (bools.has(k)) result[k] = result[k] === "1";
      else if (numbers.has(k))
        result[k] = result[k] === "" ? 0 : Number(result[k]);
      // else keep string
    }

    res.json({ data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ---- PUT: fees ----
router.put(
  "/fees",
  ensureAuth,
  requireAdmin,
  body("payment_fees_enabled").isBoolean(),
  body("payment_fees_percentage").isFloat({ min: 0, max: 100 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const pairs = sanitizePairs({
      payment_fees_enabled: req.body.payment_fees_enabled,
      payment_fees_percentage: req.body.payment_fees_percentage,
    });

    try {
      if (!pairs.length) return res.json({ ok: true });
      await upsertOptions(pool, pairs);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to save fees settings" });
    }
  }
);

// ---- PUT: VAT ----
router.put(
  "/vat",
  ensureAuth,
  requireAdmin,
  body("payment_vat_enabled").isBoolean(),
  body("payment_country_vat_enabled").isBoolean(),
  body("payment_vat_percentage").isFloat({ min: 0, max: 100 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const pairs = sanitizePairs({
      payment_vat_enabled: req.body.payment_vat_enabled,
      payment_country_vat_enabled: req.body.payment_country_vat_enabled,
      payment_vat_percentage: req.body.payment_vat_percentage,
    });

    try {
      await upsertOptions(pool, pairs);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to save VAT settings" });
    }
  }
);

// ---- PUT: Bank Transfers ----
router.put(
  "/bank",
  ensureAuth,
  requireAdmin,
  body("bank_transfers_enabled").isBoolean(),
  body("bank_name").trim().isLength({ min: 0, max: 255 }),
  body("bank_account_number").trim().isLength({ min: 0, max: 255 }),
  body("bank_account_name").trim().isLength({ min: 0, max: 255 }),
  body("bank_account_country").trim().isLength({ min: 0, max: 255 }),
  body("bank_transfer_note").trim().isLength({ min: 0, max: 5000 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const pairs = sanitizePairs({
      bank_transfers_enabled: req.body.bank_transfers_enabled,
      bank_name: req.body.bank_name,
      bank_account_number: req.body.bank_account_number,
      bank_account_name: req.body.bank_account_name,
      bank_account_country: req.body.bank_account_country,
      bank_transfer_note: req.body.bank_transfer_note,
    });

    try {
      await upsertOptions(pool, pairs);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to save bank settings" });
    }
  }
);

// ---- PUT: Online (Paystack) ----
router.put(
  "/paystack",
  ensureAuth,
  requireAdmin,
  body("paystack_enabled").isBoolean(),
  body("paystack_secret").trim().isLength({ min: 0, max: 255 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const pairs = sanitizePairs({
      paystack_enabled: req.body.paystack_enabled,
      paystack_secret: req.body.paystack_secret,
    });

    try {
      await upsertOptions(pool, pairs);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to save online payment settings" });
    }
  }
);

module.exports = router;

// ---- Upsert helper using ON DUPLICATE KEY (requires unique index on option_name) ----
async function upsertOptions(pool, pairs /* [ [name, value], ... ] */) {
  if (!pairs.length) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sql =
      "INSERT INTO system_options (option_name, option_value) VALUES ? " +
      "ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)";
    await conn.query(sql, [pairs]);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
}
