// server/routes/pro.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');                  // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth'); // your JWT guard
const { checkActivePackage } = require("../services/packageService");


/**
 * GET /api/pro/users?limit=12
 * Returns users who have an active VIP/VVIP package.
 *
 * VIP  -> valid 30 days from latest payment_date
 * VVIP -> valid 365 days from latest payment_date
 */
router.get('/users', ensureAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '12', 10), 100));

    const [rows] = await pool.query(
      `
      /* get the most recent package per user */
      SELECT 
        u.user_id            AS id,
        u.user_name          AS name,
        COALESCE(u.user_picture, '/uploads//profile/defaultavatar.png') AS avatar,
        pp.package_name      AS packageName,
        pp.payment_date      AS paidAt
      FROM users u
      JOIN (
        SELECT p1.user_id, p1.package_name, p1.payment_date
        FROM packages_payments p1
        JOIN (  
          SELECT user_id, MAX(payment_date) AS last_date
          FROM packages_payments
          GROUP BY user_id
        ) p2 ON p2.user_id = p1.user_id AND p2.last_date = p1.payment_date
        WHERE p1.package_name IN ('GADA VIP','GADA VVIP')
      ) pp ON pp.user_id = u.user_id
      /* still valid by package window */
      WHERE 
        pp.payment_date >= CASE 
          WHEN pp.package_name = 'GADA VIP'  THEN (NOW() - INTERVAL 30  DAY)
          WHEN pp.package_name = 'GADA VVIP' THEN (NOW() - INTERVAL 365 DAY)
          ELSE '1970-01-01'
        END
      ORDER BY pp.payment_date DESC
      LIMIT ?
      `,
      [limit]
    );

    res.json(rows);
  } catch (err) {
    console.error('[GET /api/pro/users] ', err);
    res.status(500).json({ error: 'Failed to fetch pro users' });
  }
});

async function getTrendingHashtags(limit = 10, interval = "24 HOUR") {
    const sql = `
      SELECT h.hashtag, COUNT(hp.hashtag_id) AS post_count
      FROM hashtags_posts hp
      JOIN hashtags h ON h.hashtag_id = hp.hashtag_id
      WHERE hp.created_at >= NOW() - INTERVAL ${interval}
      GROUP BY hp.hashtag_id
      ORDER BY post_count DESC
      LIMIT ?;
    `;
  
    const [rows] = await pool.query(sql, [limit]);
    return rows;
  }

router.get("/trending", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const interval = req.query.interval || "24 HOUR"; // or "1 HOUR", "7 DAY"
  
      const hashtags = await getTrendingHashtags(limit, interval);
      res.json({ success: true, data: hashtags });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });


  router.get("/activepackage",ensureAuth, async (req, res) => {
    try {
      const userId = req.user.userId;
      const result = await checkActivePackage(userId);

      res.json({ success: true, data: result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  router.get('/pages', ensureAuth, async (req, res) => {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
  
    try {
      const [rows] = await pool.query(
        `
        SELECT
          p.page_id,
          p.page_name,
          p.page_title,
          p.page_picture,
          p.page_likes,
          p.page_date
        FROM pages p
        WHERE p.page_boosted = '1' AND p.is_fake = '0'
        ORDER BY p.page_likes DESC, p.page_date DESC
        LIMIT ?
        `,
        [limit]
      );
  
      // Normalize for the frontend { id, name, avatar }
      const items = rows.map(r => {
        const name = (r.page_title && r.page_title.trim()) ? r.page_title : r.page_name;
        // DB stores paths like "photos/2025/01/..."; frontend will prefix with /uploads
        const avatar = r.page_picture || 'profile/defaultavatar.png';
        return {
          id: r.page_id,
          name,
          avatar,        // keep raw; client will build `${API}/uploads/${avatar}`
          likes: Number(r.page_likes || 0),
        };
      });
  
      res.json({ items });
    } catch (e) {
      console.error('[GET /pro/pages]', e);
      res.status(500).json({ error: 'Failed to load boosted pages' });
    }
  });

module.exports = router;
