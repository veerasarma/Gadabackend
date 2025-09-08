// routes/ads.routes.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// === CONFIG ===
// NGN rates – match your UI hint "Pay Per Click (₦50)"
const CPC_NGN = 50; // charge per click when bidding='click'
const CPV_NGN = 10; // charge per view  when bidding='view'

// Ensure these utilities exist in your project:
const { ensureAuth, requireAdmin } = require("../middlewares/auth"); // edit path
const pool  = require("../config/db"); // edit path

// --- Uploads (ads images) ---
const adsImageDir = path.join(process.cwd(), "uploads", "ads");
fs.mkdirSync(adsImageDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, adsImageDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg");
    cb(null, `ad_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Utility helpers
const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, msg = "Bad Request", code = 400) =>
  res.status(code).json({ ok: false, error: msg });

// Validate/normalize incoming body for create/update
function parseCampaignBody(body, userId) {
  // Frontend sends ISO datetime; DB is DATETIME
  const toDT = (s) => (s ? new Date(s) : null);
  const cleanCSV = (s) =>
    (Array.isArray(s) ? s.join(",") : (s || "").toString())
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(",");

  // ads_type = 'url' | 'post' | 'page' | 'group' | 'event'
  return {
    campaign_user_id: userId,
    campaign_title: (body.campaign_title || "").slice(0, 256),
    campaign_start_date: toDT(body.campaign_start_date),
    campaign_end_date: toDT(body.campaign_end_date),
    campaign_budget: Number(body.campaign_budget || 0),
    campaign_bidding: body.campaign_bidding === "click" ? "click" : "view", // enum('click','view') :contentReference[oaicite:2]{index=2}
    audience_countries: cleanCSV(body.audience_countries || ""),            // mediumtext CSV  :contentReference[oaicite:3]{index=3}
    audience_gender: (body.audience_gender || "all").toLowerCase(),        // varchar(32)     :contentReference[oaicite:4]{index=4}
    audience_relationship: (body.audience_relationship || "all").toLowerCase(), // varchar(64)  :contentReference[oaicite:5]{index=5}
    ads_title: body.ads_title || null,
    ads_description: body.ads_description || null,
    ads_type: (body.ads_type || "url").toLowerCase(),                       // varchar(32)     :contentReference[oaicite:6]{index=6}
    ads_url: body.ads_url || null,
    ads_post_url: body.ads_post_url || null,
    ads_page: body.ads_page || null,
    ads_group: body.ads_group || null,
    ads_event: body.ads_event || null,
    ads_placement: (body.ads_placement === "sidebar" ? "sidebar" : "newsfeed"), // enum       :contentReference[oaicite:7]{index=7}
    ads_image: body.ads_image || "",                                        // path
  };
}

// --- Create campaign ---
router.post("/campaigns", ensureAuth, async (req, res) => {
  const b = parseCampaignBody(req.body, req.user.userId);
  if (!b.campaign_title) return bad(res, "Campaign title is required");
  if (!b.campaign_start_date || !b.campaign_end_date)
    return bad(res, "Start and end dates are required");
  if (isNaN(b.campaign_budget) || b.campaign_budget <= 0)
    return bad(res, "Budget must be > 0");

  try {
    const [r] = await pool.query(
      `INSERT INTO ads_campaigns
       (campaign_user_id, campaign_title, campaign_start_date, campaign_end_date,
        campaign_budget, campaign_spend, campaign_bidding, audience_countries, audience_gender, audience_relationship,
        ads_title, ads_description, ads_type, ads_url, ads_post_url, ads_page, ads_group, ads_event,
        ads_placement, ads_image, campaign_created_date, campaign_is_active, campaign_is_approved, campaign_is_declined)
       VALUES (?,?,?,?, ?,0, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?, ?, NOW(), '1','0','0')`,
      [
        b.campaign_user_id,
        b.campaign_title,
        b.campaign_start_date,
        b.campaign_end_date,
        b.campaign_budget,
        b.campaign_bidding,
        b.audience_countries,
        b.audience_gender,
        b.audience_relationship,
        b.ads_title,
        b.ads_description,
        b.ads_type,
        b.ads_url,
        b.ads_post_url,
        b.ads_page,
        b.ads_group,
        b.ads_event,
        b.ads_placement,
        b.ads_image,
      ]
    );
    ok(res, { id: r.insertId });
  } catch (e) {
    console.error(e);
    bad(res, "Failed to create campaign");
  }
});

// --- Upload image (returns relative path to store in ads_image) ---
router.post("/upload", ensureAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return bad(res, "No file uploaded");
  const rel = `/uploads/ads/${req.file.filename}`;
  ok(res, { path: rel });
});

// --- My campaigns (paginated) ---
router.get("/campaigns", ensureAuth, async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
  const offset = (page - 1) * limit;
  try {
    const [rows] = await pool.query(
      `SELECT SQL_CALC_FOUND_ROWS *
       FROM ads_campaigns
       WHERE campaign_user_id = ?
       ORDER BY campaign_id DESC
       LIMIT ? OFFSET ?`,
      [req.user.userId, limit, offset]
    );
    const [[{ "FOUND_ROWS()": total }]] = await pool.query("SELECT FOUND_ROWS()");
    ok(res, { items: rows, page, total });
  } catch (e) {
    console.error(e);
    bad(res, "Failed to fetch campaigns");
  }
});

// --- Get one (owner or admin) ---
router.get("/campaigns/:id", ensureAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM ads_campaigns WHERE campaign_id = ?",
      [req.params.id]
    );
    if (!rows.length) return bad(res, "Not found", 404);
    const row = rows[0];
    if (row.campaign_user_id !== req.user.userId && !req.user.isAdmin)
      return bad(res, "Forbidden", 403);
    ok(res, { item: row });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// --- Pause/Resume (owner) ---
router.post("/campaigns/:id/status", ensureAuth, async (req, res) => {
  const active = req.body.active ? "1" : "0";
  try {
    const [r] = await pool.query(
      `UPDATE ads_campaigns
       SET campaign_is_active = ?
       WHERE campaign_id = ? AND campaign_user_id = ?`,
      [active, req.params.id, req.user.userId]
    );
    if (!r.affectedRows) return bad(res, "Not found or forbidden", 404);
    ok(res, {});
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// --- Admin approve/decline ---
router.post("/campaigns/:id/approve", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const [r] = await pool.query(
      `UPDATE ads_campaigns SET campaign_is_approved='1', campaign_is_declined='0'
       WHERE campaign_id = ?`,
      [req.params.id]
    );
    ok(res, { updated: r.affectedRows });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});
router.post("/campaigns/:id/decline", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const [r] = await pool.query(
      `UPDATE ads_campaigns SET campaign_is_approved='0', campaign_is_declined='1', campaign_is_active='0'
       WHERE campaign_id = ?`,
      [req.params.id]
    );
    ok(res, { updated: r.affectedRows });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

// --- Delete (owner) ---
router.delete("/campaigns/:id", ensureAuth, async (req, res) => {
  try {
    const [r] = await pool.query(
      `DELETE FROM ads_campaigns WHERE campaign_id = ? AND campaign_user_id = ?`,
      [req.params.id, req.user.userId]
    );
    ok(res, { deleted: r.affectedRows });
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

router.get("/whoami", ensureAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT user_country AS country_id,
              user_gender        AS gender,
              user_relationship  AS relationship
         FROM users
        WHERE user_id = ?`,
      [req.user.userId]
    );
    const row = rows[0] || {};
    res.json({ ok: true, ...row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to load audience hints" });
  }
});


// --- Serve one ad for a placement & audience ---
/**
 * query:
 *  placement=newsfeed|sidebar
 *  country_id=161
 *  gender=male|female|all
 *  relationship=single|married|all
 */
router.get("/serve", async (req, res) => {
  try {
    const placement = String(req.query.placement || "").toLowerCase();
    const countryId = parseInt(req.query.country_id, 10) || null;
    const gender = (req.query.gender || "").toString().toLowerCase();
    const relationship = (req.query.relationship || "").toString().toLowerCase();

    if (!["newsfeed", "sidebar"].includes(placement)) {
      return res.status(400).json({ ok: false, error: "Invalid placement" });
    }

    const where = [
      "ac.campaign_is_approved='1'",
      "ac.campaign_is_declined='0'",
      "ac.campaign_is_active='1'",
      "NOW() BETWEEN ac.campaign_start_date AND ac.campaign_end_date",
      "ac.campaign_spend < ac.campaign_budget",
      "ac.ads_placement = ?",
    ];
    const params = [placement];

    // Country filter: allow empty/NULL audience (means ALL) or matching row
    if (countryId) {
      where.push(
        "(ac.audience_countries IS NULL OR ac.audience_countries='' OR FIND_IN_SET(?, ac.audience_countries))"
      );
      params.push(countryId);
    }

    // Optional gender/relationship audience filters
    if (gender && gender !== "all") {
      where.push("(ac.audience_gender='all' OR ac.audience_gender=?)");
      params.push(gender);
    }
    if (relationship && relationship !== "all") {
      where.push("(ac.audience_relationship='all' OR ac.audience_relationship=?)");
      params.push(relationship);
    }

    const [rows] = await pool.query(
      `SELECT ac.campaign_id,
              ac.campaign_bidding,
              ac.ads_title, ac.ads_description, ac.ads_image, ac.ads_url,
              ac.ads_placement
         FROM ads_campaigns ac
        WHERE ${where.join(" AND ")}
        ORDER BY RAND()
        LIMIT 1`,
      params
    );

    if (!rows.length) return res.json({ ok: true, item: null });

    res.json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to serve ad" });
  }
});


// --- Track view/click and charge budget safely ---
async function chargeIfPossible(conn, campaign, unitCost) {
  // Stop if budget is already reached
  if (Number(campaign.campaign_spend) + unitCost > Number(campaign.campaign_budget)) {
    // pause the campaign
    await conn.query(
      `UPDATE ads_campaigns SET campaign_is_active='0' WHERE campaign_id=?`,
      [campaign.campaign_id]
    );
    return false;
  }
  await conn.query(
    `UPDATE ads_campaigns
     SET campaign_spend = campaign_spend + ?,
         campaign_views = campaign_views + 0,
         campaign_clicks = campaign_clicks + 0
     WHERE campaign_id=?`,
    [unitCost, campaign.campaign_id]
  );
  return true;
}

router.post("/:id/track-view", async (req, res) => {
  try {
    const cid = Number(req.params.id);
    const [rows] = await pool.query(`SELECT * FROM ads_campaigns WHERE campaign_id=?`, [cid]);
    if (!rows.length) return bad(res, "Not found", 404);
    const c = rows[0];
    if (c.campaign_is_active !== "1" || c.campaign_is_approved !== "1") return ok(res, { skipped: true });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // increment view & spend if bidding='view'
      await conn.query(
        `UPDATE ads_campaigns SET campaign_views = campaign_views + 1 WHERE campaign_id=?`,
        [cid]
      );
      if (c.campaign_bidding === "view") {
        const charged = await chargeIfPossible(conn, c, CPV_NGN);
        if (!charged) {
          await conn.commit();
          return ok(res, { paused: true });
        }
      }
      await conn.commit();
      ok(res, { tracked: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

router.post("/:id/track-click", async (req, res) => {
  try {
    const cid = Number(req.params.id);
    const [rows] = await pool.query(`SELECT * FROM ads_campaigns WHERE campaign_id=?`, [cid]);
    if (!rows.length) return bad(res, "Not found", 404);
    const c = rows[0];
    if (c.campaign_is_active !== "1" || c.campaign_is_approved !== "1") return ok(res, { skipped: true });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // increment click & spend if bidding='click'
      await conn.query(
        `UPDATE ads_campaigns SET campaign_clicks = campaign_clicks + 1 WHERE campaign_id=?`,
        [cid]
      );
      if (c.campaign_bidding === "click") {
        const charged = await chargeIfPossible(conn, c, CPC_NGN);
        if (!charged) {
          await conn.commit();
          return ok(res, { paused: true });
        }
      }
      await conn.commit();
      ok(res, { tracked: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Failed");
  }
});

router.get("/countries", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT country_id AS value, country_name AS label
         FROM system_countries
        WHERE enabled = '1'
        ORDER BY country_order ASC, country_name ASC`
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to load countries" });
  }
});

// UPDATE (owner or admin)
router.patch("/campaigns/:id", ensureAuth, async (req, res) => {
  try {
    const cid = Number(req.params.id);

    // fetch row to check ownership/admin
    const [rows] = await pool.query(
      "SELECT * FROM ads_campaigns WHERE campaign_id=?",
      [cid]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found" });
    const row = rows[0];
    if (row.campaign_user_id !== req.user.userId && !req.user.isAdmin) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    // sanitize payload
    const b = parseCampaignBody(req.body, row.campaign_user_id);

    // simple validation
    if (!b.campaign_title) return res.status(400).json({ ok: false, error: "Campaign title is required" });
    if (!b.campaign_start_date || !b.campaign_end_date)
      return res.status(400).json({ ok: false, error: "Start and end dates are required" });
    if (isNaN(req.body.campaign_budget) || Number(req.body.campaign_budget) <= 0)
      return res.status(400).json({ ok: false, error: "Budget must be > 0" });

    await pool.query(
      `UPDATE ads_campaigns SET
        campaign_title=?,
        campaign_start_date=?,
        campaign_end_date=?,
        campaign_budget=?,
        campaign_bidding=?,
        audience_countries=?,
        audience_gender=?,
        audience_relationship=?,
        ads_title=?,
        ads_description=?,
        ads_type=?,
        ads_url=?,
        ads_post_url=?,
        ads_page=?,
        ads_group=?,
        ads_event=?,
        ads_placement=?,
        ads_image=?
       WHERE campaign_id=?`,
      [
        b.campaign_title,
        b.campaign_start_date,
        b.campaign_end_date,
        Number(req.body.campaign_budget),
        b.campaign_bidding,
        b.audience_countries,
        b.audience_gender,
        b.audience_relationship,
        b.ads_title,
        b.ads_description,
        b.ads_type,
        b.ads_url,
        b.ads_post_url,
        b.ads_page,
        b.ads_group,
        b.ads_event,
        b.ads_placement,
        b.ads_image,
        cid,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to update campaign" });
  }
});

// DELETE (owner)
router.delete("/campaigns/:id", ensureAuth, async (req, res) => {
  try {
    const [r] = await pool.query(
      `DELETE FROM ads_campaigns WHERE campaign_id = ? AND campaign_user_id = ?`,
      [req.params.id, req.user.userId]
    );
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed" });
  }
});



module.exports = router;
