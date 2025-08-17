const express = require('express');
const { v4: uuid } = require('uuid');
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const router = express.Router();

// POST /api/shares     — share a post
router.post(
  '/',
  ensureAuth,
  async (req, res) => {
    const { postId, comment } = req.body;
    const userId = req.user.userId;

    // 1) Insert share record
    const shareId = uuid();
    try {
      await pool.query(
        `INSERT INTO post_shares (id, post_id, user_id, comment)
         VALUES (?, ?, ?, ?)`,
        [shareId, postId, userId, comment || null]
      );
      // 2) Increment cache counter
      await pool.query(
        `UPDATE posts SET share_count = share_count + 1 WHERE id = ?`,
        [postId]
      );
      res.status(201).json({ id: shareId });
    } catch (err) {
      console.error(err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Already shared' });
      }
      res.status(500).json({ error: 'Failed to share' });
    }
  }
);

// GET /api/shares/count/:postId   — get share count
router.get(
  '/count/:postId',
  ensureAuth,
  async (req, res) => {
    const postId = req.params.postId;
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM post_shares WHERE post_id = ?`,
      [postId]
    );
    res.json({ count });
  }
);

// GET /api/shares/:postId         — list recent shares (e.g. for tooltip)
router.get(
  '/:postId',
  ensureAuth,
  async (req, res) => {
    const postId = req.params.postId;
    const [rows] = await pool.query(
      `SELECT s.user_id AS userId, u.user_name, u.user_profileImage AS profileImage, s.comment, s.created_at AS createdAt
       FROM post_shares s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.post_id = ?
       ORDER BY s.created_at DESC
       LIMIT 10`,
      [postId]
    );
    res.json(rows);
  }
);

module.exports = router;
