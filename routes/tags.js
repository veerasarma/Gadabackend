// routes/tags.js
const express = require('express');
const router = express.Router();
const { ensureAuth } = require('../middlewares/auth');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');

// Tag users in a post
router.post(
  '/post/:postId/tag',
  ensureAuth,
  body('taggedUsers').isArray({ min: 1, max: 20 }),
  body('taggedUsers.*.userId').isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { postId } = req.params;
    const { taggedUsers } = req.body;
    const taggedBy = req.user.userId;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Check if post exists
      const [post] = await conn.query(
        'SELECT post_id, user_id, privacy FROM posts WHERE post_id = ?',
        [postId]
      );

      if (post.length === 0) {
        await conn.rollback();
        conn.release();
        return res.status(404).json({ error: 'Post not found' });
      }

      // Only post owner can tag users
      if (post[0].user_id !== taggedBy) {
        await conn.rollback();
        conn.release();
        return res.status(403).json({ error: 'Only post owner can tag users' });
      }

      const tagsToInsert = [];
      const notifications = [];

      for (const taggedUser of taggedUsers) {
        // Check if user exists and get their tag settings
        const [user] = await conn.query(
          `SELECT 
            user_id, 
            user_privacy_tagging, 
            user_tag_review,
            user_banned,
            user_activated
          FROM users 
          WHERE user_id = ?`,
          [taggedUser.userId]
        );

        if (user.length === 0 || user[0].user_banned === '1' || user[0].user_activated === '0') {
          continue;
        }

        // Check if already tagged
        const [existing] = await conn.query(
          'SELECT tag_id FROM posts_tags WHERE post_id = ? AND user_id = ?',
          [postId, taggedUser.userId]
        );

        if (existing.length > 0) continue;

        // Check tagging privacy
        const privacy = user[0].user_privacy_tagging;
        if (privacy === 'me') continue;

        // Determine tag status
        const needsReview = user[0].user_tag_review === '1';
        const tagStatus = needsReview ? 'pending' : 'approved';

        tagsToInsert.push([
          postId,
          taggedUser.userId,
          taggedBy,
          tagStatus
        ]);

        notifications.push({
          userId: taggedUser.userId,
          needsReview: needsReview
        });
      }

      if (tagsToInsert.length === 0) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: 'No valid users to tag' });
      }

      // Insert tags
      await conn.query(
        `INSERT INTO posts_tags 
         (post_id, user_id, tagged_by, tag_status) 
         VALUES ?`,
        [tagsToInsert]
      );

      // Update post tags count
      const approvedCount = tagsToInsert.filter(tag => tag[3] === 'approved').length;
      if (approvedCount > 0) {
        await conn.query(
          `UPDATE posts 
           SET has_tags = '1', tags_count = tags_count + ? 
           WHERE post_id = ?`,
          [approvedCount, postId]
        );
      }

      // Create notifications (optional - if you have notification system)
      for (const notif of notifications) {
        const action = notif.needsReview ? 'tag_review' : 'tag';
        try {
          await conn.query(
            `INSERT INTO notifications 
             (from_user_id, to_user_id, action, node_type, node_url, time) 
             VALUES (?, ?, ?, 'post', ?, NOW())`,
            [taggedBy, notif.userId, action, `post/${postId}`]
          );
        } catch (e) {
          // Skip if notifications table doesn't exist
        }
      }

      await conn.commit();
      res.json({ 
        ok: true, 
        message: 'Users tagged successfully',
        tagged_count: tagsToInsert.length,
        approved_count: approvedCount,
        pending_count: tagsToInsert.length - approvedCount
      });
    } catch (error) {
      await conn.rollback();
      console.error('Tag error:', error);
      res.status(500).json({ error: 'Failed to tag users' });
    } finally {
      conn.release();
    }
  }
);

// Get tags for a post
router.get('/post/:postId/tags', async (req, res) => {
  const { postId } = req.params;

  try {
    const [tags] = await pool.query(
      `SELECT 
        pt.tag_id,
        pt.user_id,
        pt.tag_status,
        pt.created_at,
        u.user_name,
        u.user_firstname,
        u.user_lastname,
        u.user_picture,
        u.user_verified
      FROM posts_tags pt
      JOIN users u ON pt.user_id = u.user_id
      WHERE pt.post_id = ? AND pt.tag_status = 'approved'
      ORDER BY pt.created_at ASC`,
      [postId]
    );

    res.json({ tags });
  } catch (error) {
    console.error('Get tags error:', error);
    res.status(500).json({ error: 'Failed to get tags' });
  }
});

// Get pending tag reviews for current user
router.get('/pending-reviews', ensureAuth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const [pendingTags] = await pool.query(
      `SELECT 
        pt.tag_id,
        pt.post_id,
        pt.created_at,
        p.text as post_text,
        p.post_type,
        u.user_id as tagger_id,
        u.user_name as tagger_username,
        u.user_firstname as tagger_firstname,
        u.user_lastname as tagger_lastname,
        u.user_picture as tagger_picture
      FROM posts_tags pt
      JOIN posts p ON pt.post_id = p.post_id
      JOIN users u ON pt.tagged_by = u.user_id
      WHERE pt.user_id = ? AND pt.tag_status = 'pending'
      ORDER BY pt.created_at DESC`,
      [userId]
    );

    res.json({ pendingTags });
  } catch (error) {
    console.error('Get pending reviews error:', error);
    res.status(500).json({ error: 'Failed to get pending reviews' });
  }
});

// Approve or decline a tag
router.put('/tag/:tagId/review', ensureAuth, async (req, res) => {
  const { tagId } = req.params;
  const { action } = req.body;
  const userId = req.user.userId;

  if (!['approve', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [tag] = await conn.query(
      `SELECT pt.*, p.user_id as post_owner_id
       FROM posts_tags pt
       JOIN posts p ON pt.post_id = p.post_id
       WHERE pt.tag_id = ? AND pt.user_id = ? AND pt.tag_status = 'pending'`,
      [tagId, userId]
    );

    if (tag.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'Tag not found or already reviewed' });
    }

    if (action === 'decline') {
      await conn.query('DELETE FROM posts_tags WHERE tag_id = ?', [tagId]);
    } else {
      await conn.query(
        'UPDATE posts_tags SET tag_status = ? WHERE tag_id = ?',
        ['approved', tagId]
      );

      await conn.query(
        `UPDATE posts 
         SET has_tags = '1', tags_count = tags_count + 1 
         WHERE post_id = ?`,
        [tag[0].post_id]
      );
    }

    await conn.commit();
    res.json({ 
      ok: true, 
      message: action === 'approve' ? 'Tag approved' : 'Tag declined' 
    });
  } catch (error) {
    await conn.rollback();
    console.error('Review tag error:', error);
    res.status(500).json({ error: 'Failed to review tag' });
  } finally {
    conn.release();
  }
});

// Remove a tag
router.delete('/tag/:tagId', ensureAuth, async (req, res) => {
  const { tagId } = req.params;
  const userId = req.user.userId;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [tag] = await conn.query(
      `SELECT pt.*, p.user_id as post_owner_id 
       FROM posts_tags pt
       JOIN posts p ON pt.post_id = p.post_id
       WHERE pt.tag_id = ?`,
      [tagId]
    );

    if (tag.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'Tag not found' });
    }

    const canRemove = 
      tag[0].user_id === userId || 
      tag[0].post_owner_id === userId || 
      tag[0].tagged_by === userId;

    if (!canRemove) {
      await conn.rollback();
      conn.release();
      return res.status(403).json({ error: 'Cannot remove this tag' });
    }

    await conn.query('DELETE FROM posts_tags WHERE tag_id = ?', [tagId]);

    if (tag[0].tag_status === 'approved') {
      await conn.query(
        `UPDATE posts 
         SET tags_count = GREATEST(0, tags_count - 1),
             has_tags = IF(tags_count - 1 > 0, '1', '0')
         WHERE post_id = ?`,
        [tag[0].post_id]
      );
    }

    await conn.commit();
    res.json({ ok: true, message: 'Tag removed successfully' });
  } catch (error) {
    await conn.rollback();
    console.error('Remove tag error:', error);
    res.status(500).json({ error: 'Failed to remove tag' });
  } finally {
    conn.release();
  }
});

// Search users for tagging
router.get('/search', ensureAuth, async (req, res) => {
  const { q } = req.query;
  const userId = req.user.userId;

  if (!q || q.length < 2) {
    return res.json({ users: [] });
  }

  try {
    const [users] = await pool.query(
      `SELECT 
        user_id,
        user_name,
        user_firstname,
        user_lastname,
        user_picture,
        user_verified
      FROM users
      WHERE user_id != ? 
        AND user_activated = '1'
        AND (
          user_name LIKE ? OR 
          user_firstname LIKE ? OR 
          user_lastname LIKE ? OR
          CONCAT(user_firstname, ' ', user_lastname) LIKE ?
        )
      LIMIT 20`,
      [userId, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
    );

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

module.exports = router;
