// routes/friends.js
const express = require('express');
const { v4: uuid } = require('uuid');
const pool = require('../config/db');         // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

/**
 * POST /api/friends/requests
 * Send a friend request (user_one_id = me, user_two_id = toUserId)
 */
router.post('/requests', ensureAuth, async (req, res) => {
  try {
    const fromUserId = Number(req.user.userId);
    const toUserId = Number(req.body?.toUserId);

    if (!toUserId || Number.isNaN(toUserId)) {
      return res.status(400).json({ error: 'toUserId required' });
    }
    if (fromUserId === toUserId) {
      return res.status(400).json({ error: 'Cannot friend yourself' });
    }

    // Prevent duplicates in any direction
    const [[existing]] = await pool.query(
      `
      SELECT id, status
        FROM friends
       WHERE (user_one_id = ? AND user_two_id = ?)
          OR (user_one_id = ? AND user_two_id = ?)
       LIMIT 1
      `,
      [fromUserId, toUserId, toUserId, fromUserId]
    );
    if (existing && existing.status !== 'declined') {
      return res.status(409).json({ error: `Already ${existing.status}` });
    }

    const id = uuid();
    await pool.query(
      `
      INSERT INTO friends ( user_one_id, user_two_id, status)
      VALUES ( ?, ?, '0')
      `,
      [fromUserId, toUserId]
    );

    res.status(201).json({ id, fromUserId, toUserId, status: 'pending' });
  } catch (e) {
    console.error('[POST /friends/requests]', e);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

/**
 * GET /api/friends/requests
 * List incoming & outgoing requests for current user
 */
router.get('/requests', ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await pool.query(
      `
      SELECT
        fr.id,
        fr.status,

        fr.user_one_id       AS fromUserId,
        fu.user_name         AS fromUsername,
        COALESCE(fu.user_picture, fu.user_picture) AS fromProfileImage,

        fr.user_two_id       AS toUserId,
        tu.user_name         AS toUsername,
        COALESCE(tu.user_picture, tu.user_picture) AS toProfileImage
      FROM friends fr
      JOIN users fu ON fu.user_id = fr.user_one_id
      JOIN users tu ON tu.user_id = fr.user_two_id
      WHERE fr.user_one_id = ? OR fr.user_two_id = ?
      ORDER BY fr.id DESC
      `,
      [userId, userId]
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /friends/requests]', e);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

/**
 * PUT /api/friends/requests/:id
 * Accept or decline a request (only the recipient can respond)
 * Body: { action: 'accepted' | 'declined' }
 */
router.put('/requests/:id', ensureAuth, async (req, res) => {
  try {
    const reqId = req.params.id;
    const action = String(req.body?.action || '').toLowerCase();
    if (!['accepted', 'declined'].includes(action)) {
      return res.status(400).json({ error: 'action must be accepted|declined' });
    }

    const userId = Number(req.user.userId);
    const [[fr]] = await pool.query(
      `SELECT user_one_id, user_two_id, status FROM friends WHERE id = ?`,
      [reqId]
    );
    if (!fr) return res.status(404).json({ error: 'Request not found' });

    if (Number(fr.user_two_id) !== userId) {
      return res.status(403).json({ error: 'Only the recipient can respond' });
    }
    if (fr.status !== 0) {
      return res.status(409).json({ error: `Already ${fr.status}` });
    }
    console.log(action,'actionaction')
    await pool.query(`UPDATE friends SET status=? WHERE id=?`, [action=='accepted'?1:0, reqId]);
    // No separate user_friends table; accepted rows represent friendships
    res.json({ id: reqId, status: action });
  } catch (e) {
    console.error('[PUT /friends/requests/:id]', e);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

/**
 * GET /api/friends/list
 * All accepted friends for current user.
 * Return the "other user" with minimal profile info.
 */
router.get('/list', ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await pool.query(
      `
      SELECT
        CASE
          WHEN fr.user_one_id = ? THEN fr.user_two_id
          ELSE fr.user_one_id
        END AS friend_id,
        u.user_name                           AS user_name,
        COALESCE(u.user_picture, u.user_picture) AS profileImage
      FROM friends fr
      JOIN users u
        ON u.user_id = CASE
                          WHEN fr.user_one_id = ? THEN fr.user_two_id
                          ELSE fr.user_one_id
                        END
      WHERE (fr.user_one_id = ? OR fr.user_two_id = ?)
        AND fr.status = 1
      ORDER BY u.user_name
      LIMIT 100 
      `,
      [userId, userId, userId, userId]
    );

    res.json(
      rows.map(r => ({
        user_id: String(r.friend_id),
        user_name: r.user_name,
        profileImage: r.profileImage || null,
      }))
    );
  } catch (e) {
    console.error('[GET /friends/list]', e);
    res.status(500).json({ error: 'Failed to load friends' });
  }
});

async function countFriends(conn, userId) {
  const uid = Number(userId);
console.log(uid,'uiduiduid')
  // We UNION the two schemas (if one doesn’t exist, that subquery just errors — we catch & ignore)
  // Safer way: attempt queries independently, then sum distinct ids in JS.


  // Schema A: users_friends(user_id, friend_id, status)
  try {
    const [rows] = await conn.query(
      `
      SELECT
        CASE
          WHEN fr.user_one_id = ? THEN fr.user_two_id
          ELSE fr.user_one_id
        END AS friend_id
        
      FROM friends fr
      
      WHERE (fr.user_one_id = ? OR fr.user_two_id = ?)
        AND fr.status = 1
      
      `,
      [uid, uid, uid, uid]
    );
    return rows.length;
    // rows?.forEach(r => ids.add(Number(r.fid)));
  } catch (e) {
    console.log(e,'ee')
    // table may not exist in some envs
  }

  // // remove self just in case
  // ids.delete(uid);


}

// GET /api/friends/count
router.get('/count', ensureAuth, async (req, res) => {
  console.log("kjfhksdjhfksdjf")
  const userId = Number(req.user?.userId || 0);
  if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const conn = await pool.getConnection();
  try {
    const count = await countFriends(conn, userId);
    return res.json({ ok: true, count });
  } catch (e) {
    console.error('[GET /friends/count]', e);
    return res.status(500).json({ ok: false, error: 'Failed to fetch count' });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/friends/suggestions
 * Suggest users:
 *  - not me
 *  - approved (if you have a flag)
 *  - no accepted friendship with me
 *  - no pending request in either direction
 */


router.get('/suggestions', ensureAuth, async (req, res) => {
  const viewer = Number(req.user.userId);
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const afterId = Number(req.query.afterId) || 0;

  try {
    const [rows] = await pool.query(
      `
      SELECT u.user_id, u.user_name, u.user_picture
      FROM users u
      LEFT JOIN (
        SELECT user_two_id AS other_id
        FROM friends
        WHERE user_one_id = ? AND status IN (1,0,-1)
        UNION ALL
        SELECT user_one_id AS other_id
        FROM friends
        WHERE user_two_id = ? AND status IN (1,0,-1)
      ) c ON c.other_id = u.user_id
      WHERE u.user_id <> ?
        AND c.other_id IS NULL
        AND u.user_id > ?
      ORDER BY u.user_id
      LIMIT ?`,
      [viewer, viewer, viewer, afterId, limit]
    );
    res.json(
            rows.map(r => ({
              user_id: String(r.user_id),
              user_name: r.user_name,
              profileImage: r.user_picture || null,
            })))
    // res.json({ items: rows, nextAfterId: rows.at(-1)?.user_id || afterId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load suggestions' });
  }
});



module.exports = router;
