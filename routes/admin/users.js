// src/routes/admin/users.js
const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const pool = require("../../config/db");             // <- adjust path if needed
const { requireAdmin } = require("../../middlewares/auth"); // or your existing ensureAuth + role check

// Utility: map DB user row -> API payload similar to your profile endpoints
function mapUserRow(u) {
  return {
    id: Number(u.user_id),
    username: u.user_name,
    email: u.user_email,
    phone: u.user_phone || "",
    firstName: u.user_firstname || "",
    lastName: u.user_lastname || "",
    gender: u.user_gender || "",
    birthdate: u.user_birthdate || null,
    bio: u.user_biography || "",
    website: u.user_website || "",
    avatar: u.user_picture || null,
    cover: u.user_cover || null,

    // balances (from users table)
    wallet: Number(u.user_wallet_balance || 0),  // users.sql has this column
    points: Number(u.user_points || 0),          // users.sql has this column

    // basic flags (optional)
    activated: u.user_activated === '1' || u.user_activated === 1,
    approved: u.user_approved === '1' || u.user_approved === 1,
    banned: u.user_banned === '1' || u.user_banned === 1,
  };
}

// GET one user (with simple membership summary)
router.get("/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [users] = await pool.query(
      `SELECT *
         FROM users
        WHERE user_id = ?
        LIMIT 1`,
      [id]
    );
    if (!users.length) return res.status(404).json({ error: "User not found" });

    const user = mapUserRow(users[0]);

    // membership summary via packages_payments (if you track membership this way)
    // NOTE: keep it read-only here; admin changes are done by grant/cancel endpoints below
    const [subs] = await pool.query(
      `SELECT pp.payment_id, pp.package_name, pp.package_price, pp.payment_date
         FROM packages_payments pp
        WHERE pp.user_id = ?
        ORDER BY pp.payment_id DESC
        LIMIT 5`,
      [id]
    );

    // include recent entries (client can render however it wants)
    user.membershipRecent = subs;

    return res.json({ data: user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update profile basics (admin overrides user profile)
router.put(
  "/:id/profile",
  requireAdmin,
  body("email").optional().isEmail().withMessage("Invalid email"),
  body("firstName").optional().isLength({ max: 64 }),
  body("lastName").optional().isLength({ max: 64 }),
//   body("gender").optional().isIn(["male", "female", "other", ""]).withMessage("Invalid gender"),
  body("birthdate").optional().isISO8601().toDate(),
  async (req, res) => {
    const id = Number(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      username,
      email,
      phone,
      firstName,
      lastName,
      gender,
      birthdate,
      bio,
      website,
      avatar,   // path string, if you let admins change it directly
      cover,    // path string
    } = req.body;

    try {
      const fields = [];
      const values = [];

      if (username != null) { fields.push("user_name = ?"); values.push(String(username)); }
      if (email != null)    { fields.push("user_email = ?"); values.push(String(email)); }
      if (phone != null)    { fields.push("user_phone = ?"); values.push(String(phone)); }
      if (firstName != null){ fields.push("user_firstname = ?"); values.push(String(firstName)); }
      if (lastName != null) { fields.push("user_lastname = ?"); values.push(String(lastName)); }
      if (gender != null)   { fields.push("user_gender = ?"); values.push(String(gender)); }
      if (birthdate != null){ fields.push("user_birthdate = ?"); values.push(birthdate); }
      if (bio != null)      { fields.push("user_biography = ?"); values.push(String(bio)); }
      if (website != null)  { fields.push("user_website = ?"); values.push(String(website)); }
      if (avatar != null)   { fields.push("user_picture = ?"); values.push(String(avatar)); }
      if (cover != null)    { fields.push("user_cover = ?"); values.push(String(cover)); }

      if (!fields.length) return res.json({ ok: true, updated: 0 });

      values.push(id);
      const [r] = await pool.query(
        `UPDATE users SET ${fields.join(", ")} WHERE user_id = ?`,
        values
      );
      res.json({ ok: true, updated: r.affectedRows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

// Adjust wallet / points with audit
router.post(
  "/:id/balances",
  requireAdmin,
  body("walletDelta").optional().isFloat(),
  body("pointsDelta").optional().isFloat(),
  body("reason").optional().isLength({ max: 255 }),
  async (req, res) => {
    const id = Number(req.params.id);
    const { walletDelta = 0, pointsDelta = 0, reason = "admin adjustment" } = req.body;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Lock the row
      const [rows] = await conn.query(
        "SELECT user_wallet_balance, user_points FROM users WHERE user_id = ? FOR UPDATE",
        [id]
      );
      if (!rows.length) throw new Error("User not found");

      // Wallet
      if (walletDelta && Number(walletDelta) !== 0) {
        await conn.query(
          "UPDATE users SET user_wallet_balance = user_wallet_balance + ? WHERE user_id = ?",
          [Number(walletDelta), id]
        );
        // Audit in wallet_payments (no schema change)
        // Positive = admin_credit, Negative = admin_debit
        const method = Number(walletDelta) >= 0 ? "admin_credit" : "admin_debit";
        await conn.query(
          `INSERT INTO wallet_payments
            (user_id, amount, method, method_value, time, status)
           VALUES (?, ?, ?, ?, NOW(), 1)`,
          [id, Math.abs(Number(walletDelta)), method, reason]
        );
      }

      // Points (assuming users.user_points exists per schema)
      if (pointsDelta && Number(pointsDelta) !== 0) {
        await conn.query(
          "UPDATE users SET user_points = user_points + ? WHERE user_id = ?",
          [Number(pointsDelta), id]
        );
        // Optional: if you keep a points_ledger table, insert there too.
      }

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error(e);
      res.status(400).json({ error: e.message || "Failed to adjust balances" });
    } finally {
      conn.release();
    }
  }
);
    // add a period_num + period (Day/Month/Year) to a date
    function addPeriod(dt, num, unit) {
      const d = new Date(dt);
      const u = String(unit || "").toLowerCase();
      const n = Number(num || 0);
  
      if (!n) return d;
  
      if (u.startsWith("day")) {
        d.setDate(d.getDate() + n);
      } else if (u.startsWith("month")) {
        d.setMonth(d.getMonth() + n);
      } else if (u.startsWith("year")) {
        d.setFullYear(d.getFullYear() + n);
      } else {
        // Fallback: days
        d.setDate(d.getDate() + n);
      }
      return d;
    }
  
    function toIsoOrNull(x) {
      try { return x ? new Date(x).toISOString() : null; } catch { return null; }
    }
  
    // compute remaining days (clamped to 0)
    function remainingDays(from, to) {
      if (!from || !to) return 0;
      const ms = new Date(to) - new Date(from);
      return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    }
  
    // Load package row by id
    async function getPackageById(packageId) {
      const [rows] = await pool.query(
        `SELECT package_id, name, price, period_num, period,
                verification_badge_enabled, boost_posts_enabled, boost_posts,
                boost_pages_enabled, boost_pages,
                allowed_blogs_categories, allowed_videos_categories, allowed_products
           FROM packages
          WHERE package_id = ?
          LIMIT 1`,
        [packageId]
      );
      return rows[0] || null;
    }
  
    // Build SAME response shape used previously by the UI
    async function buildMembershipSummary(userId) {
        // 1) Load user subscription flags + usage
        const [uRows] = await pool.query(
          `SELECT
             user_subscribed, user_package, user_subscription_date,
             COALESCE(user_boosted_posts, 0) AS boostedPostsUsed,
             COALESCE(user_boosted_pages, 0) AS boostedPagesUsed
           FROM users
           WHERE user_id = ?
           LIMIT 1`,
          [userId]
        );
      
        const u = uRows[0];
        // Base object with safe defaults (also used for early returns)
        const base = {
          active: false,
          packageId: null,
          packageName: null,
          price: null,
          period: null,
          period_num: null,
          subscribedAt: null,
          expiresAt: null,
          usage: {
            boostedPostsUsed: Number(u?.boostedPostsUsed ?? 0),
            boostedPagesUsed: Number(u?.boostedPagesUsed ?? 0),
          },
          limits: {
            boostPostsLimit: 0,
            boostPagesLimit: 0,
          },
        };
      
        if (!u) return base;
      
        const userSubscribed =
          u.user_subscribed === 1 || u.user_subscribed === "1";
        const packageId = u.user_package ?? null;
        const subscribedAt = u.user_subscription_date
          ? new Date(u.user_subscription_date)
          : null;
      
        if (!userSubscribed || !packageId || !subscribedAt) {
          // not subscribed → return defaults + usage we already put in base
          return base;
        }
      
        // 2) Load package row
        const [pkgRows] = await pool.query(
          `SELECT package_id, name, price, period_num, period,
                  boost_posts, boost_pages
             FROM packages
            WHERE package_id = ?
            LIMIT 1`,
          [packageId]
        );
        const pkg = pkgRows[0];
        if (!pkg) return base;
      
        // 3) Compute expiry from subscription date + package period
        const expiryDate = addPeriod(subscribedAt, pkg.period_num, pkg.period);
        const isActive = new Date() <= expiryDate;
      
        // 4) Build the requested shape
        return {
          active: isActive,
          packageId: Number(pkg.package_id),
          packageName: pkg.name || null,
          price: pkg.price != null ? Number(pkg.price) : null,
          period: pkg.period || null,
          period_num: pkg.period_num != null ? Number(pkg.period_num) : null,
          subscribedAt: toIsoOrNull(subscribedAt),
          expiresAt: toIsoOrNull(expiryDate),
      
          usage: {
            boostedPostsUsed: Number(u.boostedPostsUsed || 0),
            boostedPagesUsed: Number(u.boostedPagesUsed || 0),
          },
      
          limits: {
            boostPostsLimit: Number(pkg.boost_posts || 0),
            boostPagesLimit: Number(pkg.boost_pages || 0),
          },
        };
      }
    // ---- routes ---------------------------------------------------------------
  
    // GET /api/admin/users/:id/membership
    router.get("/:id/membership", requireAdmin, async (req, res) => {
      const id = Number(req.params.id);
      try {
        const summary = await buildMembershipSummary(id);
        return res.json({ ok: true, data: summary });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: "Failed to fetch membership" });
      }
    });
  
    // POST /api/admin/users/:id/membership/plan  { packageId }
    router.post("/:id/membership/plan", requireAdmin, async (req, res) => {
      const id = Number(req.params.id);
      const packageId = Number(req.body?.packageId || 0);
      if (!packageId) {
        return res.status(400).json({ ok: false, error: "packageId required" });
      }
  
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
  
        const [pkgRows] = await conn.query(
          `SELECT package_id, name, period_num, period
             FROM packages
            WHERE package_id = ?
            LIMIT 1`,
          [packageId]
        );
        const pkg = pkgRows[0];
        if (!pkg) throw new Error("Package not found");
  
        // set subscribed + package + start date; reset usage counters
        await conn.query(
          `UPDATE users
              SET user_subscribed = '1',
                  user_package = ?,
                  user_subscription_date = NOW(),
                  user_boosted_posts = 0,
                  user_boosted_pages = 0
            WHERE user_id = ?`,
          [packageId, id]
        );
  
        await conn.commit();
        res.json({ ok: true });
      } catch (e) {
        try { await conn.rollback(); } catch {}
        console.error(e);
        res.status(500).json({ ok: false, error: "Failed to update membership" });
      } finally {
        conn.release();
      }
    });
  
    // POST /api/admin/users/:id/membership/unsubscribe
    router.post("/:id/membership/unsubscribe", requireAdmin, async (req, res) => {
      const id = Number(req.params.id);
      try {
        await pool.query(
          `UPDATE users
              SET user_subscribed = '0'
            WHERE user_id = ?`,
          [id]
        );
        res.json({ ok: true });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: "Failed to unsubscribe user" });
      }
    });
  
    // GET /api/admin/packages  -> for dropdown
    router.get("/packages/list", requireAdmin, async (_req, res) => {
      try {
        const [rows] = await pool.query(
          `SELECT package_id, name, price, period_num, period
             FROM packages
            ORDER BY package_order ASC, package_id ASC`
        );
        res.json({ ok: true, data: rows });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: "Failed to fetch packages" });
      }
    });

    /**
 * PATCH /api/admin/users/:id/suspend
 * Body: { banned?: boolean }
 * - If "banned" provided => set to 1/0
 * - If missing => toggle current value
 */
router.post('/:id/suspend', requireAdmin, async (req, res) => {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid user id' });
    }
  
    // (optional) prevent suspending yourself
    if (req.user && Number(req.user.userId) === id) {
      return res.status(400).json({ ok: false, error: 'You cannot suspend your own account.' });
    }
  
    try {
      const conn = pool;
  
      // Read current banned state
      const [rows] = await conn.query(
        'SELECT user_banned FROM users WHERE user_id = ? LIMIT 1',
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ ok: false, error: 'User not found' });
      }
  
      const current = rows[0].user_banned === 1 || rows[0].user_banned === '1';
      // If the caller provides explicit "banned", use it; otherwise toggle
      let next = current ? 0 : 1;
      if (typeof req.body?.banned !== 'undefined') {
        next = req.body.banned ? '1' : '0';
      }
  
      await conn.query(
        'UPDATE users SET user_banned = ? WHERE user_id = ?',
        [next, id]
      );
  
      return res.json({
        ok: true,
        userId: id,
        banned: Boolean(req.body.banned ? 1 : 0),
      });
    } catch (err) {
      console.error('[admin:users:suspend]', err);
      return res.status(500).json({ ok: false, error: 'Failed to update user state' });
    }
  });
  
 
module.exports = router;
