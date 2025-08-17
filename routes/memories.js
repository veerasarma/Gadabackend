// routes/memories.js
const express = require('express');
const pool = require('../config/db'); // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

/** Normalize a post row from DB to API shape used by frontend PostItem */
function mapPostRow(r) {
  return {
    id: r.post_id,
    author: {
      id: r.user_id,
      username: r.authorUsername,
      profileImage: r.authorProfileImage || null,
    },
    content: r.text || '',
    createdAt: r.time,        // ISO from MySQL
    images: [],
    videos: [],
    likes: [],
    comments: [],
    shareCount: Number(r.shares || 0),
    hasShared: false,         // optional if you later add user shares
    hasSaved: false,
  };
}

/** Build absolute URL from relative DB path if needed */
function absUrl(req, rel) {
  if (!rel) return '';
  const s = String(rel);
  if (/^https?:\/\//i.test(s)) return s;
  const cleaned = s.replace(/^\/+/, '');
  // serve from /uploads/... if path already starts with uploads/, otherwise prefix it
  return `${req.protocol}://${req.get('host')}/${cleaned.startsWith('uploads/') ? cleaned : `uploads/${cleaned}`}`;
}

/**
 * GET /api/memories
 * Posts from past years that happened on THIS month/day.
 */
router.get('/', ensureAuth, async (req, res) => {
  try {
    const me = Number(req.user.userId);

    // 1) Base posts that match today's month/day from previous years
    const [posts] = await pool.query(`
      SELECT
        p.post_id,
        p.user_id,
        p.text,
        p.time,
        p.shares,
        u.user_name                                        AS authorUsername,
        u.user_picture AS authorProfileImage
      FROM posts p
      JOIN users u ON u.user_id = p.user_id
      WHERE p.is_hidden = '0'
        AND MONTH(p.time) = MONTH(CURDATE())
        AND DAY(p.time)   = DAY(CURDATE())
        AND YEAR(p.time)  < YEAR(CURDATE())
      ORDER BY p.time DESC
      LIMIT 200
    `);

    if (!posts.length) return res.json([]);

    const postIds = posts.map(p => p.post_id);

    // 2) Related: images (from posts_media and posts_photos), videos, likes, comments
    const [
      mediaRows,
      photoRows,
      videoRows,
      likeRows,
      commentRows,
      savedRows,
    ] = await Promise.all([
      pool.query(
        `SELECT post_id, source_url, source_type
           FROM posts_media
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      // additional photo table you asked to include
      pool.query(
        `SELECT post_id, source
           FROM posts_photos
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      pool.query(
        `SELECT post_id, source
           FROM posts_videos
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      pool.query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.reaction='like' AND r.post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      pool.query(
        `SELECT
            c.comment_id,
            c.node_id AS post_id,
            c.user_id,
            c.text,
            c.time,
            u.user_name,
            u.user_picture AS profileImage
         FROM posts_comments c
         JOIN users u ON u.user_id = c.user_id
        WHERE c.node_type='post' AND c.node_id IN (?)
        ORDER BY c.time ASC`,
        [postIds]
      ).then(([r]) => r),

      // for hasSaved flag (optional UX nicety)
      pool.query(
        `SELECT post_id FROM posts_saved WHERE user_id=? AND post_id IN (?)`,
        [me, postIds]
      ).then(([r]) => r),
    ]);

    const savedSet = new Set(savedRows.map(r => r.post_id));

    // 3) Stitch
    const byId = new Map(posts.map(p => [p.post_id, mapPostRow(p)]));

    // images from posts_media
    for (const m of mediaRows) {
      if (m.source_type === 'image') {
        const post = byId.get(m.post_id);
        if (post) post.images.push((req, m.source_url));
      }
    }
    // images from posts_photos
    for (const ph of photoRows) {
      const post = byId.get(ph.post_id);
      if (post) post.images.push((req, ph.source));
    }
    // videos
    for (const v of videoRows) {
      const post = byId.get(v.post_id);
      if (post) post.videos.push((req, v.source));
    }
    // likes
    for (const l of likeRows) {
      const post = byId.get(l.post_id);
      if (post) post.likes.push({ userId: String(l.user_id), username: l.user_name });
    }
    // comments
    for (const c of commentRows) {
      const post = byId.get(c.post_id);
      if (post) {
        post.comments.push({
          id: String(c.comment_id),
          userId: String(c.user_id),
          username: c.user_name,
          profileImage: c.profile_image ? (req, c.profile_image) : null,
          content: c.text,
          createdAt: c.time,
        });
      }
    }
    // hasSaved
    for (const id of savedSet) {
      const p = byId.get(id);
      if (p) p.hasSaved = true;
    }

    res.json([...byId.values()]);
  } catch (err) {
    console.error('[GET /memories]', err);
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

module.exports = router;
