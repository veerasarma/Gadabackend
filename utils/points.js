// helpers/points.js
// Node.js (no TypeScript). Requires mysql2 pool to be passed in.
const {pool} = require('../config/db'); 

async function creditPoints({
    
    userId,
    nodeId = 0,
    type,                 // 'post' | 'post_create' | 'post_view' | 'post_like' | 'post_comment' | 'follow' | 'refer'
    req = null,           // if available, used for req.system
    systemConfig = null,  // optional override when req not available
    checkActivePackage,   // async (userId) => { active: boolean }
  }) {
    if (!userId || !type) {
      return { ok: false, error: 'Missing required params (pool, userId, type).' };
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
  
    // Determine daily limit from package
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
    
    const windowHrs = Number(sys.POINTS_RESET_WINDOW_HOURS ?? 24);
const sinceDate = new Date(Date.now() - windowHrs * 3600 * 1000);

// index-friendly sum (pass timestamp, not INTERVAL)
const sumSql = `
  SELECT COALESCE(SUM(points),0) AS earned
    FROM log_points
   WHERE user_id = ?
     AND time >= ?
`;

// optional: force index if you added idx_logpoints_user_time_points
// const sumSql = `... FROM log_points FORCE INDEX (idx_logpoints_user_time_points) WHERE ...`;

const [sumRows] = await conn.query(sumSql, [userId, sinceDate]);
const earned = Number(sumRows[0]?.earned || 0);
      // const earned = 0;
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

  
      // Insert history (log_points) — schema: (user_id, node_id, node_type, points, time)
      await conn.query(
        `INSERT INTO log_points (user_id, node_id, node_type, points, time)
         VALUES (?, ?, ?, ?, NOW())`,
        [userId, nodeId, normalizedType, toAward]
      );
      // console.log(toAward,typeof toAward)
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
  