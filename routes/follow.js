// routes/follow.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const { creditPoints } = require('../utils/points');

// Follow a user
router.post('/:userId/follow', ensureAuth, async (req, res) => {
  const followingId = Number(req.params.userId);
  const userId = Number(req.user.userId);

  if (userId === followingId) {
    return res.status(400).json({ error: 'You cannot follow yourself' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Check if user exists
    const [targetUser] = await conn.query(
      'SELECT user_id, user_banned, user_activated FROM users WHERE user_id = ?',
      [followingId]
    );

    if (!targetUser || targetUser.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'User not found' });
    }
    // console.log(targetUser[0].user_activated,'targetUser[0].user_activated')
    // if (targetUser[0].user_activated === '0') {
    //   await conn.rollback();
    //   conn.release();
    //   return res.status(400).json({ error: 'Cannot follow this user' });
    // }

    // Check if already following
    const [existing] = await conn.query(
      'SELECT id FROM followings WHERE user_id = ? AND following_id = ?',
      [userId, followingId]
    );

    if (existing && existing.length > 0) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'Already following this user' });
    }

    // Insert follow relationship
    await conn.query(
      'INSERT INTO followings (user_id, following_id, points_earned, time) VALUES (?, ?, 1, NOW())',
      [userId, followingId]
    );

    // Create notification
    try {
      await conn.query(
        `INSERT INTO notifications (from_user_id, to_user_id, action, node_type, node_url, time) 
         VALUES (?, ?, 'follow', 'user', ?, NOW())`,
        [userId, followingId, `profile/${followingId}`]
      );
    } catch (err) {
      console.error('Notification error:', err);
    }

    // Award points (optional)
    try {
      await creditPoints(
        pool,
        userId,
        followingId,
        'follow',
        req,
        null
      );
    } catch (err) {
      console.error('Points error:', err);
    }

    await conn.commit();
    res.json({ 
      ok: true, 
      message: 'Successfully followed user',
      isFollowing: true 
    });
  } catch (error) {
    await conn.rollback();
    console.error('Follow error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  } finally {
    conn.release();
  }
});

// Unfollow a user
router.delete('/:userId/follow', ensureAuth, async (req, res) => {
  const followingId = Number(req.params.userId);
  const userId = Number(req.user.userId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Check if following
    const [existing] = await conn.query(
      'SELECT id FROM followings WHERE user_id = ? AND following_id = ?',
      [userId, followingId]
    );

    if (!existing || existing.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'Not following this user' });
    }

    // Delete follow relationship
    await conn.query(
      'DELETE FROM followings WHERE user_id = ? AND following_id = ?',
      [userId, followingId]
    );

    await conn.commit();
    res.json({ 
      ok: true, 
      message: 'Successfully unfollowed user',
      isFollowing: false 
    });
  } catch (error) {
    await conn.rollback();
    console.error('Unfollow error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  } finally {
    conn.release();
  }
});

// Check if following a user
router.get('/:userId/is-following', ensureAuth, async (req, res) => {
  const followingId = Number(req.params.userId);
  const userId = Number(req.user.userId);

  try {
    const [result] = await pool.query(
      'SELECT id FROM followings WHERE user_id = ? AND following_id = ?',
      [userId, followingId]
    );

    res.json({ isFollowing: result && result.length > 0 });
  } catch (error) {
    console.error('Check following error:', error);
    res.status(500).json({ error: 'Failed to check follow status' });
  }
});

// Get followers of a user
router.get('/:userId/followers', async (req, res) => {
  const userId = Number(req.params.userId);
  const { limit = 20, offset = 0 } = req.query;

  try {
    const [followers] = await pool.query(
      `SELECT 
        f.id,
        f.user_id,
        f.time,
        u.user_username,
        u.user_firstname,
        u.user_lastname,
        u.user_picture,
        u.user_verified
       FROM followings f
       JOIN users u ON f.user_id = u.user_id
       WHERE f.following_id = ?
       ORDER BY f.time DESC
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const [count] = await pool.query(
      'SELECT COUNT(*) as total FROM followings WHERE following_id = ?',
      [userId]
    );

    res.json({ 
      followers, 
      total: count[0].total,
      hasMore: count[0].total > (parseInt(offset) + followers.length)
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// Get following list of a user
router.get('/:userId/following', async (req, res) => {
  const userId = Number(req.params.userId);
  const { limit = 20, offset = 0 } = req.query;

  try {
    const [following] = await pool.query(
      `SELECT 
        f.id,
        f.following_id as user_id,
        f.time,
        u.user_username,
        u.user_firstname,
        u.user_lastname,
        u.user_picture,
        u.user_verified
       FROM followings f
       JOIN users u ON f.following_id = u.user_id
       WHERE f.user_id = ?
       ORDER BY f.time DESC
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const [count] = await pool.query(
      'SELECT COUNT(*) as total FROM followings WHERE user_id = ?',
      [userId]
    );

    res.json({ 
      following, 
      total: count[0].total,
      hasMore: count[0].total > (parseInt(offset) + following.length)
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following list' });
  }
});

// Get followers and following count
router.get('/:userId/counts', async (req, res) => {
  const userId = Number(req.params.userId);

  try {
    const [followers] = await pool.query(
      'SELECT COUNT(*) as count FROM followings WHERE following_id = ?',
      [userId]
    );

    const [following] = await pool.query(
      'SELECT COUNT(*) as count FROM followings WHERE user_id = ?',
      [userId]
    );

    res.json({
      followers: followers[0].count,
      following: following[0].count
    });
  } catch (error) {
    console.error('Get counts error:', error);
    res.status(500).json({ error: 'Failed to get counts' });
  }
});

module.exports = router;
