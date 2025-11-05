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


async function getOption(conn, name) {
  const [rows] = await conn.query(
    `SELECT option_value
       FROM system_options
      WHERE LOWER(option_name) = LOWER(?)
      LIMIT 1`,
    [name]
  );
  return rows.length ? rows[0].option_value : null;
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

router.get('/testing', async (req, res, next)=> {
    const { creditPoints } = require('../utils/points');
    const userId = 9008;
    const postId = 359865;
   const out = await creditPoints({
        userId: userId,
        nodeId: postId,
        type: 'post_comment',               // or 'post_create'
        req,                        // so it can read req.system
        checkActivePackage,         // your existing fn
    });
    res.json(out)
});
/**
 * GET /api/points/overview
 * Returns points rules (from system config), current balances and remaining daily points.
 */
// router.get('/overview', ensureAuth, async (req, res) => {
//   const userId = req.user.userId;
//   console.log(userId,'userId')
//   const conn = await pool.getConnection();
//   const sys = (req.system) || {};
//   try {
//     // balances
//     const [urows] = await conn.query(
//       `SELECT user_points, user_wallet_balance
//          FROM users
//         WHERE user_id = ?
//         LIMIT 1`,
//       [userId]
//     );
//     if (!urows.length) return res.status(404).json({ error: 'User not found' });

//     // settings
//     const enabledRaw = await getOption(conn, 'points_money_transfer_enabled');
//     const pointsPerCurrencyRaw = await getOption(conn, 'points_per_currency');

//     const enabled = String(enabledRaw ?? '0').trim() === '1' || /^true$/i.test(String(enabledRaw));
//     const pointsPerCurrency = Number(pointsPerCurrencyRaw) > 0 ? Number(pointsPerCurrencyRaw) : 10; // default safeguard

//     // ---- daily remaining: sum points earned in last X hours (default 24) ----
//     const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);
//     const [sumRows] = await pool.query(
//       `SELECT COALESCE(SUM(points),0) AS earned
//          FROM log_points
//         WHERE user_id = ?
//           AND time >= (NOW() - INTERVAL ? HOUR)`,
//       [userId, windowHrs]
//     );

//     const result = await checkActivePackage(userId);
//     console.log(result,userId)
//     let daily_limit = (result.active)?sys.points_limit_pro:sys.points_limit_user ?? 1000

//     const earned = Number(sumRows[0].earned || 0);
//     const remainingToday = Math.max(0, daily_limit - earned);

//     // shape matches what your PointsPage already expects (see conversion usage)
//     return res.json({
//       balances: {
//         points: Number(urows[0].user_points) || 0,
//         money: Number(urows[0].user_wallet_balance) || 0,
//       },
//       rules: {
//         conversion: {
//           // your UI shows: "Each X points equal ₦1"
//           pointsPerNaira: pointsPerCurrency,
//           enabled,
//         },
//         // keep room for other rules your UI shows (post_create, etc.) if you already return them
//         post_create: Number(sys.points_per_post ?? 10),
//       post_view: Number(sys.points_per_post_view ?? 1),
//       post_comment: Number(sys.points_per_post_comment ?? 5),
//       follow: Number(sys.points_per_follow ?? 5),
//       refer: Number(sys.points_per_referred ?? 5),
//       daily_limit: Number(daily_limit ?? 1000),
//       },
//       remainingToday: remainingToday,
//       windowHours: 24,
//     });
//   } catch (e) {
//     console.error('[points/overview]', e);
//     res.status(500).json({ error: 'Failed to load overview' });
//   } finally {
//     conn.release();
//   }
// });

router.get('/overview', ensureAuth, async (req, res) => {
  const userId = req.user.userId;
  const conn = await pool.getConnection();
  const sys = req.system || {};

  try {
    // 1) fetch balances (ensure user exists)
    const [urows] = await conn.query(
      `SELECT user_points, user_wallet_balance
         FROM users
        WHERE user_id = ?
        LIMIT 1`,
      [userId]
    );
    if (!urows.length) return res.status(404).json({ error: 'User not found' });

    // 2) compute window boundary (index-friendly timestamp)
    const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);
    const sinceDate = new Date(Date.now() - windowHrs * 3600 * 1000);

    // 3) start independent operations in parallel:
    //    - fetch options (using existing getOption which handles missing options table)
    //    - sum points in window (use conn, pass timestamp)
    //    - check active package
    const optsPromise = Promise.all([
      getOption(conn, 'points_money_transfer_enabled').catch(() => null),
      getOption(conn, 'points_per_currency').catch(() => null),
    ]);

    const sumSql = `SELECT COALESCE(SUM(points),0) AS earned
                      FROM log_points
                     WHERE user_id = ?
                       AND time >= ?`;
    const sumPromise = conn.query(sumSql, [userId, sinceDate]);

    const packagePromise = checkActivePackage(userId);

    const [[enabledRaw, pointsPerCurrencyRaw], packageResult] =
      await Promise.all([optsPromise,  packagePromise]);

    // 4) parse and sanitize option values (same semantics as your original)
    const enabled =
      String(enabledRaw ?? '0').trim() === '1' ||
      /^true$/i.test(String(enabledRaw));

    const pointsPerCurrency =
      Number(pointsPerCurrencyRaw) > 0 ? Number(pointsPerCurrencyRaw) : 10;

    // 5) daily limit logic (preserve original behavior but clearer)
    const pkgActive = Boolean(packageResult && packageResult.active);
    const dailyLimitFromSys = Number(sys.points_limit_user ?? 1000);
    const dailyLimitPro = Number(sys.points_limit_pro ?? dailyLimitFromSys);
    const daily_limit = pkgActive ? (dailyLimitPro || 1000) : (dailyLimitFromSys || 1000);

    // 6) remaining calculation
    const earned = Number(sumRows[0].earned || 0);
    // const earned = 0;
    const remainingToday = Math.max(0, daily_limit - earned);

    // 7) return same JSON shape (windowHours now reflects configured window)
    return res.json({
      balances: {
        points: Number(urows[0].user_points) || 0,
        money: Number(urows[0].user_wallet_balance) || 0,
      },
      rules: {
        conversion: {
          pointsPerNaira: pointsPerCurrency,
          enabled,
        },
        post_create: Number(sys.points_per_post ?? 10),
        post_view: Number(sys.points_per_post_view ?? 1),
        post_comment: Number(sys.points_per_post_comment ?? 5),
        follow: Number(sys.points_per_follow ?? 5),
        refer: Number(sys.points_per_referred ?? 5),
        daily_limit: Number(daily_limit ?? 1000),
      },
      remainingToday,
      windowHours: windowHrs,
    });
  } catch (e) {
    console.error('[points/overview]', e);
    return res.status(500).json({ error: 'Failed to load overview' });
  } finally {
    conn.release();
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

router.post('/transfer', ensureAuth, async (req, res) => {
  const userId = req.user.userId;
  const pointsRequested = Number(req.body?.points);

  if (!Number.isFinite(pointsRequested) || pointsRequested <= 0) {
    return res.status(400).json({ error: 'Invalid points amount' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Read config
    const enabledRaw = await getOption(conn, 'points_money_transfer_enabled');
    const pointsPerCurrencyRaw = await getOption(conn, 'points_per_currency');

    const enabled = String(enabledRaw ?? '0').trim() === '1' || /^true$/i.test(String(enabledRaw));
    if (!enabled) {
      await conn.rollback();
      return res.status(403).json({ error: 'Points to money transfer is disabled' });
    }

    const PPC = Number(pointsPerCurrencyRaw);
    if (!Number.isFinite(PPC) || PPC <= 0) {
      await conn.rollback();
      return res.status(500).json({ error: 'Invalid conversion setting' });
    }

    // Lock row, validate balance
    const [rows] = await conn.query(
      `SELECT user_points, user_wallet_balance
         FROM users
        WHERE user_id = ?
        FOR UPDATE`,
      [userId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'User not found' });
    }

    const currentPoints = Number(rows[0].user_points) || 0;
    if (pointsRequested > currentPoints) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient points balance' });
    }

    // money = points / PPC  (Each PPC points = ₦1)
    const moneyGainedRaw = pointsRequested / PPC;
    // round to 2 decimals
    const moneyGained = Math.round((moneyGainedRaw + Number.EPSILON) * 100) / 100;

    // Apply transfer
    await conn.query(
      `UPDATE users
          SET user_points = user_points - ?,
              user_wallet_balance = user_wallet_balance + ?
        WHERE user_id = ?`,
      [pointsRequested, moneyGained, userId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      moved: { points: pointsRequested, money: moneyGained },
      balances: {
        points: currentPoints - pointsRequested,
        money: Number(rows[0].user_wallet_balance) + moneyGained,
      },
      ppc: PPC,
    });
  } catch (e) {
    console.error('[points/transfer]', e);
    try { await conn.rollback(); } catch {}
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    conn.release();
  }
});

module.exports = router;
