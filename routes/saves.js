// routes/saves.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');               // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

/** Make 'photos/2025/08/x.jpg' => 'http://host/uploads/photos/2025/08/x.jpg' */
function absUrl(req, rel) {
  if (!rel) return '';
  const s = String(rel);
  if (/^https?:\/\//i.test(s)) return s; // already absolute
  const cleaned = s.replace(/^\/+/, '');
  return `${req.protocol}://${req.get('host')}/uploads/${cleaned}`;
}

/* ------------------------------------------
   Save a post
   POST /api/saves
------------------------------------------- */
router.post(
  '/',
  ensureAuth,
  express.json(),
  body('postId').isInt().toInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.userId;
    const { postId } = req.body;

    try {
      // Ensure unique (add a unique index on (user_id,post_id) to support INSERT IGNORE)
      await pool.query(
        `INSERT IGNORE INTO posts_saved (user_id, post_id) VALUES (?, ?)`,
        [userId, postId]
      );
      res.status(201).json({ postId });
    } catch (err) {
      console.error('[POST /api/saves]', err);
      res.status(500).json({ error: 'Failed to save post' });
    }
  }
);

/* ------------------------------------------
   Unsave a post
   DELETE /api/saves/:postId
------------------------------------------- */
router.delete(
  '/:postId',
  ensureAuth,
  async (req, res) => {
    const userId = req.user.userId;
    const postId = Number(req.params.postId);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ error: 'Invalid postId' });
    }

    try {
      await pool.query(
        `DELETE FROM posts_saved WHERE user_id = ? AND post_id = ?`,
        [userId, postId]
      );
      res.status(204).end();
    } catch (err) {
      console.error('[DELETE /api/saves/:postId]', err);
      res.status(500).json({ error: 'Failed to unsave post' });
    }
  }
);

/* ------------------------------------------
   List saved posts for current user
   GET /api/saves
------------------------------------------- */
router.get('/', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 1) saved IDs
    const [savedRows] = await pool.query(
      `SELECT post_id FROM posts_saved WHERE user_id = ?`,
      [userId]
    );
    const savedIds = savedRows.map(r => r.post_id);
    if (!savedIds.length) return res.json([]);

    // 2) posts + author
    const [posts] = await pool.query(
      `
      SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares, p.is_hidden,
             u.user_name      AS authorUsername,
             u.user_picture   AS authorProfileImage
        FROM posts p
        JOIN users u ON u.user_id = p.user_id
       WHERE p.is_hidden = '0' AND p.post_id IN (?)
       ORDER BY p.time DESC
      `,
      [savedIds]
    );
    if (!posts.length) return res.json([]);

    const postIds = posts.map(p => p.post_id);

    // 3) bulk fetch related
    const [
      [mediaRows],         // posts_media (images only)
      [photoRows],         // posts_photos (images)
      [videoRows],         // posts_videos
      [likeRows],          // posts_reactions (like)
      [commentRows],       // posts_comments (with users)
      shareCounts          // optional posts_shares (if table exists)
    ] = await Promise.all([
      pool.query(
        `SELECT post_id, source_url, source_type
           FROM posts_media
          WHERE post_id IN (?) AND source_type = 'image'`,
        [postIds]
      ),
      pool.query(
        `SELECT post_id, source FROM posts_photos WHERE post_id IN (?)`,
        [postIds]
      ),
      pool.query(
        `SELECT post_id, source FROM posts_videos WHERE post_id IN (?)`,
        [postIds]
      ),
      pool.query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id IN (?) AND r.reaction = 'like'`,
        [postIds]
      ),
      pool.query(
        `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                u.user_name, u.user_picture
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type = 'post' AND c.node_id IN (?)
          ORDER BY c.time ASC`,
        [postIds]
      ),
      // try posts_shares if present; if not, we’ll fall back to p.shares
      pool
        .query(
          `SELECT post_id, COUNT(*) AS count
             FROM posts_shares
            WHERE post_id IN (?)
            GROUP BY post_id`,
          [postIds]
        )
        .then(([rows]) => rows)
        .catch(() => []),
    ]);

    // share map from posts_shares (optional)
    const shareMap = {};
    for (const r of shareCounts) shareMap[r.post_id] = Number(r.count) || 0;

    // Set of saved (they all are saved)
    const savedSet = new Set(savedIds);

    // Build final
    const enriched = posts.map(p => {
      const pid = p.post_id;

      // images can come from posts_media and/or posts_photos
      const images = [
        ...mediaRows.filter(m => m.post_id === pid).map(m => (req, m.source_url)),
        ...photoRows.filter(ph => ph.post_id === pid).map(ph => (req, ph.source)),
      ];

      const videos = videoRows
        .filter(v => v.post_id === pid)
        .map(v => (req, v.source));

      const likes = likeRows
        .filter(l => l.post_id === pid)
        .map(l => ({ userId: String(l.user_id), username: l.user_name }));

      const comments = commentRows
        .filter(c => c.post_id === pid)
        .map(c => ({
          id:        String(c.comment_id),
          userId:    String(c.user_id),
          username:  c.user_name,
          profileImage: (req, c.user_picture || ''),
          content:   c.text,
          createdAt: c.time,
        }));

      return {
        id: String(pid),
        author: {
          id: String(p.user_id),
          username: p.authorUsername,
          profileImage: (req, p.authorProfileImage || ''),
        },
        content:   p.text || '',
        createdAt: p.time,
        images,
        videos,
        likes,
        comments,
        shareCount: shareMap[pid] ?? Number(p.shares ?? 0),
        hasShared:  false,             // set true if you also track user shares
        hasSaved:   savedSet.has(pid), // true
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('[GET /api/saves]', err);
    res.status(500).json({ error: 'Failed to fetch saved posts.' });
  }
});

module.exports = router;
