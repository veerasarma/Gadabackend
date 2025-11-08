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



// async function creditPoints({
    
//     userId,
//     nodeId = 0,
//     type,                 // 'post' | 'post_create' | 'post_view' | 'post_like' | 'post_comment' | 'follow' | 'refer'
//     req = null,           // if available, used for req.system
//     systemConfig = null,  // optional override when req not available
//     checkActivePackage,   // async (userId) => { active: boolean }
//   }) {
//     if (!userId || !type) {
//       return { ok: false, error: 'Missing required params (pool, userId, type).' };
//     }
   
//     const sys = (systemConfig || (req && req.system)) || {};
//     const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);

//     // Normalize type + map to config keys
//     const norm = String(type).toLowerCase();
//     const normalizedType =
//       norm === 'post' ? 'post_create' :
//       norm === 'posts_reactions' ? 'posts_reactions' :
//       norm;


//     const rulePoints = {
//       post_create: Number(sys.points_per_post ?? 0),
//       post_view: Number(sys.points_per_post_view ?? 0),
//       post_comment: Number(sys.points_per_post_comment ?? 0),
//       posts_reactions: Number(sys.points_per_post_like ?? (sys.points_per_post_reaction ?? 0)),
//       follow: Number(sys.points_per_follow ?? 5),
//       refer: Number(sys.points_per_referred ?? 5),
//     }[normalizedType];
//     if (!rulePoints || rulePoints <= 0) {
//       return { ok: false, error: `No positive rulePoints for type=${normalizedType}` };
//     }
  
//     // Determine daily limit from package
//     if (typeof checkActivePackage !== 'function') {
//       return { ok: false, error: 'checkActivePackage function is required' };
//     }
   
//     const { active } = await checkActivePackage(userId);

//     const baseDailyLimit = active ? sys.points_limit_pro : sys.points_limit_user;
//     const dailyLimit = Number(baseDailyLimit ?? 1000);
  
//     const conn = await pool.promise().getConnection();
//     try {
//       await conn.beginTransaction();

//       // Optional idempotency for one-off actions (not for views)
//       const isOneOff = !['post_view'].includes(normalizedType);
//       if (isOneOff && nodeId) {
//         const [dupe] = await conn.query(
//           `SELECT log_id FROM log_points
//             WHERE user_id=? AND node_id=? AND node_type=? LIMIT 1`,
//           [userId, nodeId, normalizedType]
//         );
//         if (dupe.length) {
//             await conn.rollback();
//             conn.release();
//             return { ok: true, awarded: 0, reason: 'duplicate', type: normalizedType };
//         }
//     }
    
//     const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);
// const sinceDate = new Date(Date.now() - windowHrs * 3600 * 1000);

// // index-friendly sum (pass timestamp, not INTERVAL)
// const sumSql = `
//   SELECT COALESCE(SUM(points),0) AS earned
//     FROM log_points
//    WHERE user_id = ?
//      AND time >= ?
// `;

// // optional: force index if you added idx_logpoints_user_time_points
// // const sumSql = `... FROM log_points FORCE INDEX (idx_logpoints_user_time_points) WHERE ...`;

// const [sumRows] = await conn.query(sumSql, [userId, sinceDate]);
// const earned = Number(sumRows[0]?.earned || 0);
//       // const earned = 0;
//       const remainingToday = Math.max(0, dailyLimit - earned);
  
//       if (remainingToday <= 0) {
//         await conn.rollback();
//         conn.release();
//         return { ok: true, awarded: 0, reason: 'daily_limit_reached', remainingToday: 0, type: normalizedType };
//       }
  
//       const toAward = Math.min(rulePoints, remainingToday);
  
//       // Lock user row to avoid race conditions and get current points
//       const [userRows] = await conn.query(
//         `SELECT user_points FROM users WHERE user_id=? FOR UPDATE`,
//         [userId]
//       );
//       const currentPoints = Number(userRows[0]?.user_points || 0);

  
//       // Insert history (log_points) — schema: (user_id, node_id, node_type, points, time)
//       await conn.query(
//         `INSERT INTO log_points (user_id, node_id, node_type, points, time)
//          VALUES (?, ?, ?, ?, NOW())`,
//         [userId, nodeId, normalizedType, toAward]
//       );
//       // console.log(toAward,typeof toAward)
//       // Update user_points
//       await conn.query(
//         `UPDATE users
//             SET user_points   = COALESCE(user_points, 0)   + ?,
//                 points_earned = '1'
//           WHERE user_id = ?`,
//         [toAward, userId]
//       );
  
//       await conn.commit();
//       conn.release();
  
//       return {
//         ok: true,
//         type: normalizedType,
//         awarded: toAward,
//         remainingToday: Math.max(0, remainingToday - toAward),
//         balances: { points: currentPoints + toAward },
//       };
//     } catch (err) {
//       await conn.rollback();
//       conn.release();
//       return { ok: false, error: err.message || String(err) };
//     }
//   }
  
function pad(n){ return n < 10 ? '0'+n : '' }

function hourBucketKey(userId, dateObj) {
  // dateObj is a JS Date: produce YYYYMMDDHH
  const y = dateObj.getUTCFullYear();
  const m = pad(dateObj.getUTCMonth() + 1);
  const d = pad(dateObj.getUTCDate());
  const h = pad(dateObj.getUTCHours());
  return `user:${userId}:points:hour:${y}${m}${d}${h}`; // UTC buckets to avoid DST issues
}

function lastNHourKeys(userId, n) {
  const keys = [];
  const now = new Date();
  // use UTC hours for consistency
  for (let i = 0; i < n; i++) {
    const dt = new Date(now.getTime() - i * 3600 * 1000);
    keys.push(hourBucketKey(userId, dt));
  }
  return keys;
}

async function bootstrapHourlyBucketsFromDb(conn, userId, windowHrs) {
  // Return map hour_label -> sum for last windowHrs hours.
  // We'll try a UTC-safe query first (using CONVERT_TZ),
  // and if MariaDB rejects it we fall back to a simple DATE_FORMAT(time, '%Y%m%d%H') version.

  const sinceDate = new Date(Date.now() - windowHrs * 3600 * 1000);
  const sinceSql = sinceDate.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:mm:ss'

  // Preferred query (works if CONVERT_TZ is available and time zones are configured)
  const preferredSql = `
    SELECT DATE_FORMAT(CONVERT_TZ(time, @@session.time_zone, '+00:00'), '%Y%m%d%H') AS hour_label,
           COALESCE(SUM(points),0) AS s
    FROM log_points
    WHERE user_id = ?
      AND time >= ?
    GROUP BY hour_label
  `;

  // Fallback query (widest compatibility). Assumes `time` is stored in UTC.
  const fallbackSql = `
    SELECT DATE_FORMAT(time, '%Y%m%d%H') AS hour_label,
           COALESCE(SUM(points),0) AS s
    FROM log_points
    WHERE user_id = ?
      AND time >= ?
    GROUP BY hour_label
  `;

  try {
    const [rows] = await conn.query(preferredSql, [userId, sinceSql]);
    const map = {};
    for (const r of rows) map[r.hour_label] = Number(r.s || 0);
    return map;
  } catch (err) {
    // If preferred query fails (syntax or missing tz support), try fallback.
    console.warn('preferred bootstrap query failed, trying fallback. err=', err && err.message);
    try {
      const [rows2] = await conn.query(fallbackSql, [userId, sinceSql]);
      const map2 = {};
      for (const r of rows2) map2[r.hour_label] = Number(r.s || 0);
      return map2;
    } catch (err2) {
      // If fallback also fails, rethrow so outer logic can handle it (it will still work by reading SUM directly).
      console.error('bootstrapHourlyBucketsFromDb: both preferred and fallback queries failed', err2 && err2.message);
      throw err2;
    }
  }
}

async function getEarnedLastWindowFromRedisOrDb(conn, userId, windowHrs) {
  // 1) compute keys for last windowHrs (UTC-based)
  const keys = lastNHourKeys(userId, windowHrs); // returns [currentHourKey, prevHourKey, ...]
  // Try to MGET
  let vals;
  try {
    vals = await redisClient.mget(...keys); // returns array of strings or nulls
  } catch (err) {
    // If Redis fails, fall back to DB query once
    vals = null;
  }

  if (Array.isArray(vals)) {
    // Sum numeric values (null or missing => 0)
    let sum = 0;
    let anyPopulated = false;
    for (const v of vals) {
      if (v !== null && v !== undefined) {
        const n = Number(v);
        if (!Number.isNaN(n)) {
          sum += n;
          anyPopulated = true;
        }
      }
    }

    if (anyPopulated) {
      return {earned: sum, populatedFrom: 'redis'};
    }
    // else fall through to bootstrap from DB
  }

  // Redis not populated for this user: bootstrap from DB grouped-by-hour and set Redis keys
  const hourMap = await bootstrapHourlyBucketsFromDb(conn, userId, windowHrs);

  // Build pipeline to set keys for each relevant hour (including zeros) and TTL
  const ttl = (windowHrs + 2) * 3600; // slack
  const pipeline = redisClient.pipeline();
  const now = new Date();
  for (let i = 0; i < windowHrs; i++) {
    const dt = new Date(now.getTime() - i * 3600 * 1000);
    const key = hourBucketKey(userId, dt);
    const hourLabel = `${dt.getUTCFullYear()}${pad(dt.getUTCMonth()+1)}${pad(dt.getUTCDate())}${pad(dt.getUTCHours())}`;
    const val = Number(hourMap[hourLabel] || 0);
    pipeline.set(key, String(val), 'EX', ttl);
  }
  await pipeline.exec().catch(() => {}); // ignore pipeline errors (we still return DB sum)

  // Sum from hourMap
  let total = 0;
  for (const v of Object.values(hourMap)) total += Number(v || 0);
  // But DB grouped-by-hour sums only include hours where there are rows; hours with zero are implicitly 0.

  return { earned: total, populatedFrom: 'db' };
}

async function creditPoints({
  userId,
  nodeId = 0,
  type,                 // 'post' | 'post_create' | 'post_view' | 'post_like' | 'post_comment' | 'follow' | 'refer'
  req = null,           // if available, used for req.system
  systemConfig = null,  // optional override when req not available
  checkActivePackage,   // async (userId) => { active: boolean }
}) {
  if (!userId || !type) {
    return { ok: false, error: 'Missing required params (userId, type).' };
  }

  const sys = (systemConfig || (req && req.system)) || {};
  const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);

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

    // === Redis-backed read for earned in the window ===
    const { earned } = await getEarnedLastWindowFromRedisOrDb(conn, userId, windowHrs);
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

    // === After successful commit: update Redis hourly bucket for this user ===
    try {
      const now = new Date();
      const currentKey = hourBucketKey(userId, now);
      // increment current hour bucket
      // Use pipeline to set TTL safely
      const ttl = (windowHrs + 2) * 3600;
      const p = redisClient.pipeline();
      p.incrby(currentKey, toAward);
      p.expire(currentKey, ttl);
      await p.exec();
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
  module.exports = { creditPoints };
  