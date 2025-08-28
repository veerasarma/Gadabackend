// src/routes/adminPackages.js
const path = require("path");
const fs = require("fs");
const express = require("express");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const pool = require("../../config/db");
const { ensureAuth, requireAdmin } = require("../../middlewares/auth");

const router = express.Router();

// ---------- uploads ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads", "photos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = new Date();
    const y = ts.getFullYear();
    const m = String(ts.getMonth() + 1).padStart(2, "0");
    const base = path.basename(file.originalname, path.extname(file.originalname)).replace(/\s+/g, "_");
    cb(null, `${y}-${m}-${base}-${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });

// ---------- helpers ----------
const i = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bToEnum = (v) => (v ? "1" : "0");

// ---------- list (search + pagination + sorting) ----------
router.get("/", ensureAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, i(req.query.page, 1));
  const pageSize = Math.min(100, Math.max(1, i(req.query.pageSize, 10)));
  const search = (req.query.search || "").trim();
  const sort = (req.query.sort || "package_id").toLowerCase(); // name|price|period|order
  const order = (req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  let orderSql = `ORDER BY p.package_id ${order}`;
  if (["name", "price", "period", "package_order"].includes(sort)) {
    orderSql = `ORDER BY p.${sort} ${order}`;
  }

  const where = [];
  const params = [];
  if (search) {
    where.push("p.name LIKE ?");
    params.push(`%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [[{ cnt = 0 } = {}]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM packages p ${whereSql}`,
      params
    );

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT
        p.package_id, p.name, p.price, p.period_num, p.period, p.color, p.icon,
        p.package_permissions_group_id, p.allowed_blogs_categories, p.allowed_videos_categories,
        p.allowed_products, p.verification_badge_enabled, p.boost_posts_enabled, p.boost_posts,
        p.boost_pages_enabled, p.boost_pages, p.custom_description, p.package_order,
        p.paypal_billing_plan, p.stripe_billing_plan
       FROM packages p
       ${whereSql}
       ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      items: rows,
      page,
      pageSize,
      total: Number(cnt),
      totalPages: Math.max(1, Math.ceil(Number(cnt) / pageSize)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load packages" });
  }
});

// ---------- read ----------
router.get("/:id", ensureAuth, requireAdmin, async (req, res) => {
  const id = i(req.params.id, 0);
  try {
    const [rows] = await pool.query("SELECT * FROM packages WHERE package_id = ? LIMIT 1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to read package" });
  }
});

// validators shared for create/update
const validators = [
  body("name").trim().isLength({ min: 2 }),
  body("price").trim().isLength({ min: 1 }), // stored as varchar in DB
  body("period_num").isInt({ min: 1 }),
  body("period").isIn(["day", "month", "year"]),
  body("color").trim().matches(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i),
  body("package_permissions_group_id").optional().isInt({ min: 0 }),
  body("allowed_blogs_categories").isInt({ min: 0 }),
  body("allowed_videos_categories").isInt({ min: 0 }),
  body("allowed_products").isInt({ min: 0 }),
  body("verification_badge_enabled").isBoolean(),
  body("boost_posts_enabled").isBoolean(),
  body("boost_posts").isInt({ min: 0 }),
  body("boost_pages_enabled").isBoolean(),
  body("boost_pages").isInt({ min: 0 }),
  body("package_order").isInt({ min: 0 }),
];

// ---------- create ----------
router.post(
  "/",
  ensureAuth,
  requireAdmin,
  upload.single("icon"),
  validators,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, price, period_num, period, color,
      package_permissions_group_id = 0,
      allowed_blogs_categories, allowed_videos_categories, allowed_products,
      verification_badge_enabled, boost_posts_enabled, boost_posts,
      boost_pages_enabled, boost_pages, custom_description = "",
      package_order = 0, paypal_billing_plan = "", stripe_billing_plan = "",
    } = req.body;

    const iconRelPath = req.file
      ? path.join("photos", req.file.filename).replace(/\\/g, "/")
      : "";

    try {
      const [r] = await pool.query(
        `INSERT INTO packages
          (name, price, period_num, period, color, icon,
           package_permissions_group_id, allowed_blogs_categories, allowed_videos_categories,
           allowed_products, verification_badge_enabled, boost_posts_enabled, boost_posts,
           boost_pages_enabled, boost_pages, custom_description, package_order,
           paypal_billing_plan, stripe_billing_plan)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          name, String(price), Number(period_num), period, color, iconRelPath,
          Number(package_permissions_group_id), Number(allowed_blogs_categories), Number(allowed_videos_categories),
          Number(allowed_products), bToEnum(verification_badge_enabled), bToEnum(boost_posts_enabled), Number(boost_posts),
          bToEnum(boost_pages_enabled), Number(boost_pages), custom_description, Number(package_order),
          paypal_billing_plan, stripe_billing_plan,
        ]
      );
      res.json({ ok: true, id: r.insertId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to create package" });
    }
  }
);

// ---------- update ----------
router.put(
  "/:id",
  ensureAuth,
  requireAdmin,
  upload.single("icon"),
  validators,
  async (req, res) => {
    const id = i(req.params.id, 0);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, price, period_num, period, color,
      package_permissions_group_id = 0,
      allowed_blogs_categories, allowed_videos_categories, allowed_products,
      verification_badge_enabled, boost_posts_enabled, boost_posts,
      boost_pages_enabled, boost_pages, custom_description = "",
      package_order = 0, paypal_billing_plan = "", stripe_billing_plan = "",
      keep_icon = "true",
    } = req.body;

    let iconSql = "";
    const params = [
      name, String(price), Number(period_num), period, color,
      Number(package_permissions_group_id), Number(allowed_blogs_categories),
      Number(allowed_videos_categories), Number(allowed_products),
      bToEnum(verification_badge_enabled), bToEnum(boost_posts_enabled), Number(boost_posts),
      bToEnum(boost_pages_enabled), Number(boost_pages), custom_description, Number(package_order),
      paypal_billing_plan, stripe_billing_plan
    ];

    if (req.file && keep_icon !== "true") {
      const rel = path.join("photos", req.file.filename).replace(/\\/g, "/");
      iconSql = ", icon = ? ";
      params.push(rel);
    }

    params.push(id);

    try {
      const [r] = await pool.query(
        `UPDATE packages SET
          name=?, price=?, period_num=?, period=?, color=?,
          package_permissions_group_id=?, allowed_blogs_categories=?, allowed_videos_categories=?,
          allowed_products=?, verification_badge_enabled=?, boost_posts_enabled=?, boost_posts=?,
          boost_pages_enabled=?, boost_pages=?, custom_description=?, package_order=?,
          paypal_billing_plan=?, stripe_billing_plan=?
          ${iconSql}
         WHERE package_id=?`,
        params
      );
      if (!r.affectedRows) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to update package" });
    }
  }
);

// ---------- delete ----------
router.delete("/:id", ensureAuth, requireAdmin, async (req, res) => {
  const id = i(req.params.id, 0);
  try {
    const [r] = await pool.query("DELETE FROM packages WHERE package_id = ?", [id]);
    if (!r.affectedRows) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete package" });
  }
});

module.exports = router;
