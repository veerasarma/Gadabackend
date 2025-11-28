// helpers/points.js
// Node.js (no TypeScript). Requires mysql2 pool to be passed in.
const {pool} = require('../config/db'); 

const Redis = require('ioredis');

const redisClient = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  // optional: enable auto-reconnect / retryStrategy here
});

// Optional: handle error logging once
redisClient.on('error', (err) => {
  console.error('Redis error', err);
});

function pad(n){ return n < 10 ? '0'+n : '' }

// --- Single Redis Key Per User for 24hr Window ---

// async function getEarnedLastWindowFromRedisOrDb(conn, userId) {
//   const key = `user:${userId}:points24h`;
//   let val;
//   try {
//     val = await redisClient.get(key);
//   } catch (err) {
//     val = null;
//   }

//   if (val !== null && val !== undefined) {
//     return { earned: Number(val) || 0, populatedFrom: 'redis' };
//   }

//   // Redis key absent: backfill from DB and set key with 24h TTL
//   const sinceDate = new Date(Date.now() - 24 * 3600 * 1000);
//   const sinceSql = sinceDate.toISOString().slice(0, 19).replace('T', ' ');
//   const sql = `
//     SELECT COALESCE(SUM(points),0) AS s
//     FROM log_points
//     WHERE user_id = ?
//       AND time >= ?
//   `;
//   let total = 0;
//   try {
//     const [rows] = await conn.query(sql, [userId, sinceSql]);
//     total = Number(rows[0]?.s || 0);
//     await redisClient.set(key, total, 'EX', 24 * 3600);
//   } catch (err) {
//     // fallback: no Redis set
//   }
//   return { earned: total, populatedFrom: 'db' };
// }

async function getEarnedLastWindowFromRedisOrDb(conn, userId,testNowUTC = null) {
  const key = `user:${userId}:points24h`;
  let val;
  try {
    val = await redisClient.get(key);
  } catch (err) {
    val = null;
  }

  if (val !== null && val !== undefined) {
    console.log('Redis hit for user', userId, 'points24h=', val);
    return { earned: Number(val) || 0, populatedFrom: 'redis' };
  }

  // Use test date/time if provided, otherwise current actual time
  const nowUTC = testNowUTC ? new Date(testNowUTC) : new Date();

  const nigeriaOffsetMillis = 1 * 60 * 60 * 1000; // UTC+1
  const nowNigeria = new Date(nowUTC.getTime() + nigeriaOffsetMillis);

  // --- Calculate current Nigerian midnight (start of day) ---
  const nigeriaMidnightLocal = new Date(
    nowNigeria.getFullYear(),
    nowNigeria.getMonth(),
    nowNigeria.getDate(), 0, 0, 0
  );
  const nigeriaMidnightUTC = new Date(nigeriaMidnightLocal.getTime() - nigeriaOffsetMillis);

  // --- Prepare MySQL datetime format (UTC) ---
  const sinceSql = nigeriaMidnightUTC.toISOString().slice(0, 19).replace('T', ' ');

  // --- Calculate seconds remaining until next Nigerian midnight ---
  const nextNigeriaMidnightLocal = new Date(
    nowNigeria.getFullYear(),
    nowNigeria.getMonth(),
    nowNigeria.getDate() + 1, 0, 0, 0
  );
  const nextNigeriaMidnightUTC = new Date(nextNigeriaMidnightLocal.getTime() - nigeriaOffsetMillis);
  const secondsUntilNextNigeriaMidnight = Math.floor((nextNigeriaMidnightUTC - nowUTC) / 1000);

  // --- Run DB query and set Redis expiry to match the Nigerian day boundary ---
  const sql = `
    SELECT COALESCE(SUM(points),0) AS s
    FROM log_points
    WHERE user_id = ?
      AND time >= ?
  `;

  let total = 0;
  try {
    const [rows] = await conn.query(sql, [userId, sinceSql]);
    total = Number(rows[0]?.s || 0);
    await redisClient.set(key, total, 'EX', secondsUntilNextNigeriaMidnight);
  } catch (err) {
    // fallback: no Redis set
  }
  return { earned: total, populatedFrom: 'db' };
}



// --- Main Business Logic Function ---

async function creditPoints({
  userId,
  nodeId = 0,
  type,                 // 'post' | ...
  req = null,           // request object
  systemConfig = null,  // config override
  checkActivePackage,   // async (userId) => { active: boolean }
}) {
  if (!userId || !type) {
    return { ok: false, error: 'Missing required params (userId, type).' };
  }

  const sys = (systemConfig || (req && req.system)) || {};
  const windowHrs = 24; // unused, for context

  // Normalize type + map to config keys
  const norm = String(type).toLowerCase();
  const normalizedType =
    norm === 'post' ? 'post_create' :
    norm === 'posts_reactions' ? 'posts_reactions' :
    norm;

  const rulePoints = {
    post_create: Number(sys.points_per_post ?? 0),
    post_view: Number(sys.points_per_post_view ?? 0),
    post_comment: Number(sys.points_per_post_comment ?? 0),
    posts_reactions: Number(sys.points_per_post_like ?? (sys.points_per_post_reaction ?? 0)),
    follow: Number(sys.points_per_follow ?? 5),
    refer: Number(sys.points_per_referred ?? 5),
  }[normalizedType];

  if (!rulePoints || rulePoints <= 0) {
    return { ok: false, error: `No positive rulePoints for type=${normalizedType}` };
  }

  if (typeof checkActivePackage !== 'function') {
    return { ok: false, error: 'checkActivePackage function is required' };
  }

  const { active } = await checkActivePackage(userId);
  const baseDailyLimit = active ? sys.points_limit_pro : sys.points_limit_user;
  const dailyLimit = Number(baseDailyLimit ?? 1000);

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Optional idempotency for one-off actions (not for views)
    const isOneOff = !['post_view'].includes(normalizedType);
    if (isOneOff && nodeId) {
      const [dupe] = await conn.query(
        `SELECT log_id FROM log_points
          WHERE user_id=? AND node_id=? AND node_type=? LIMIT 1`,
        [userId, nodeId, normalizedType]
      );
      if (dupe.length) {
        await conn.rollback();
        conn.release();
        return { ok: true, awarded: 0, reason: 'duplicate', type: normalizedType };
      }
    }

    // === Check last 24h earned ===
    if(userId=='9010'){
      const { earned } = await getEarnedLastWindowFromRedisOrDb(conn, userId,'2025-11-27T23:05:00Z');
    }
    else
    {
      const { earned } = await getEarnedLastWindowFromRedisOrDb(conn, userId);
    }
  

    console.log(dailyLimit,'dailyLimit',userId);
    console.log(earned,'earned',userId);
    const remainingToday = Math.max(0, dailyLimit - earned);

    if (remainingToday <= 0) {
      await conn.rollback();
      conn.release();
      return { ok: true, awarded: 0, reason: 'daily_limit_reached', remainingToday: 0, type: normalizedType };
    }

    const toAward = Math.min(rulePoints, remainingToday);

    // Lock user row to avoid race conditions and get current points
    const [userRows] = await conn.query(
      `SELECT user_points FROM users WHERE user_id=? FOR UPDATE`,
      [userId]
    );
    const currentPoints = Number(userRows[0]?.user_points || 0);

    // Insert history (log_points)
    await conn.query(
      `INSERT INTO log_points (user_id, node_id, node_type, points, time)
       VALUES (?, ?, ?, ?, NOW())`,
      [userId, nodeId, normalizedType, toAward]
    );

    // Update user_points
    await conn.query(
      `UPDATE users
          SET user_points   = COALESCE(user_points, 0)   + ?,
              points_earned = '1'
        WHERE user_id = ?`,
      [toAward, userId]
    );

    await conn.commit();
    conn.release();

    // === After successful commit: update Redis 24h bucket for this user ===
    try {
      const key = `user:${userId}:points24h`;
      const exists = await redisClient.exists(key);
      if (exists) {
        await redisClient.incrby(key, toAward);
        // Optionally: leave TTL unchanged, so counter auto-resets after first activity in the window
      } else {
        // Key missing: repopulate sum from DB plus award, set TTL
        const sinceDate = new Date(Date.now() - 24 * 3600 * 1000);
        const sinceSql = sinceDate.toISOString().slice(0, 19).replace('T', ' ');
        const sql = `
          SELECT COALESCE(SUM(points),0) AS s
          FROM log_points
          WHERE user_id = ?
            AND time >= ?
        `;
        let total = toAward;
        try {
          const [rows] = await pool.promise().query(sql, [userId, sinceSql]);
          total = Number(rows[0]?.s || 0) + toAward;
        } catch (err) {}
        await redisClient.set(key, total, 'EX', 24 * 3600);
      }
    } catch (redisErr) {
      // Do not fail the whole operation if Redis is down; just log
      console.error('Redis update failed for user', userId, redisErr);
    }

    return {
      ok: true,
      type: normalizedType,
      awarded: toAward,
      remainingToday: Math.max(0, remainingToday - toAward),
      balances: { points: currentPoints + toAward },
    };
  } catch (err) {
    await conn.rollback();
    conn.release();
    return { ok: false, error: err.message || String(err) };
  }
}

  module.exports = { creditPoints,getEarnedLastWindowFromRedisOrDb };
  