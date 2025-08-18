// routes/points.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');              // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth'); // your existing auth
const { checkActivePackage } = require("../services/packageService");


/** Helpers */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function dirSafe(v) { return v === 'asc' ? 'ASC' : 'DESC'; }
function sortSafe(v) {
  switch (v) {
    case 'points': return 'points';
    case 'node_id': return 'node_id';
    case 'time':
    default: return 'time';
  }
}

// Map DB node_type → friendly "From"
function prettyFrom(nodeType) {
  switch (nodeType) {
    case 'post_view': return 'Post View';
    case 'post_comment': 
    case 'comment': return 'Comment';
    case 'post_reaction':
    case 'posts_reactions': return 'Reaction';
    case 'follow': return 'Follow';
    case 'post_create': return 'Added Post';
    case 'refer': return 'Referral';
    default: return nodeType.replace(/_/g, ' ');
  }
}

/**
 * GET /api/points/overview
 * Returns points rules (from system config), current balances and remaining daily points.
 */
router.get('/overview', ensureAuth, async (req, res, next)=> {
  try {
    const userId = req.user.userId;

    // ---- Pull rules from your loaded system config (middleware attached) ----
    // Fallbacks are safe defaults if a key is missing.
    const sys = (req.system) || {};
    const result = await checkActivePackage(userId);
    let daily_limit = (result.active)?sys.points_limit_pro:sys.points_limit_user ?? 1000
    const rules = {
      post_create: Number(sys.points_per_post ?? 10),
      post_view: Number(sys.points_per_post_view ?? 1),
      post_comment: Number(sys.points_per_post_comment ?? 5),
      follow: Number(sys.points_per_follow ?? 5),
      refer: Number(sys.points_per_referred ?? 5),
      daily_limit: Number(daily_limit ?? 1000),
      conversion: {
        // “Each 10 points equal ₦1” → 10 points per naira
        pointsPerNaira: Number(sys.POINTS_PER_NAIRA ?? 10),
        nairaPerPoint: 1 / Number(sys.POINTS_PER_NAIRA ?? 10)
      }
    };


    // ---- user balances (you already keep user_points & user_wallet_balance) ----
    const [balRows] = await pool.query(
      `SELECT user_points AS points, user_wallet_balance AS money
         FROM users WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    const balances = balRows.length
      ? { points: Number(balRows[0].points || 0), money: Number(balRows[0].money || 0) }
      : { points: 0, money: 0 };

    // ---- daily remaining: sum points earned in last X hours (default 24) ----
    const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);
    const [sumRows] = await pool.query(
      `SELECT COALESCE(SUM(points),0) AS earned
         FROM log_points
        WHERE user_id = ?
          AND time >= (NOW() - INTERVAL ? HOUR)`,
      [userId, windowHrs]
    );
    const earned = Number(sumRows[0].earned || 0);
    const remainingToday = Math.max(0, rules.daily_limit - earned);

    res.json({ rules, balances, remainingToday, windowHours: windowHrs });
  } catch (err) {
    console.error('[points/overview]', err);
    res.status(500).json({ error: 'Failed to load points overview' });
  }
});

/**
 * GET /api/points/logs?page=1&limit=10&q=&sort=time&dir=desc
 * Paginated user transactions from log_points. Uses safe placeholders.
 */
router.get('/logs', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, num(req.query.page, 1));
    const limit = Math.min(100, num(req.query.limit, 10));
    const q = (req.query.q || '').toString().trim();
    const sort = sortSafe((req.query.sort || '').toString());
    const dir = dirSafe((req.query.dir || '').toString());
    const offset = (page - 1) * limit;

    const where = ['user_id = ?'];
    const params = [userId];

    if (q) {
      // Search node_type OR node_id OR points text match
      where.push('(node_type LIKE ? OR CAST(node_id AS CHAR) LIKE ? OR CAST(points AS CHAR) LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // total count
    const [cnt] = await pool.query(
      `SELECT COUNT(*) AS total FROM log_points ${whereSql}`,
      params
    );
    const total = Number(cnt[0]?.total || 0);

    // page rows
    const [rows] = await pool.query(
      `SELECT log_id, user_id, node_id, node_type, points, time
         FROM log_points
         ${whereSql}
         ORDER BY ${sort} ${dir}
         LIMIT ? OFFSET ?`,
      params.concat([limit, offset])
    );
   

    const data = rows.map(r => ({
      id: Number(r.log_id),
      points: Number(r.points),
      from: prettyFrom(r.node_type),
      nodeId: Number(r.node_id),
      nodeType: r.node_type,
      time: r.time // ISO from DB; format on client
    }));

    res.json({
      page,
      pageSize: limit,
      total,
      rows: data
    });
  } catch (err) {
    console.error('[points/logs]', err);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

module.exports = router;
