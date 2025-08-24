// routes/watch.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');               // mysql2 pool (promise)
const { ensureAuth } = require('../middlewares/auth');

// Map a row to your Post shape used on the client
function mapAuthor(r) {
  return {
    id: String(r.user_id),
    username: r.user_name,
    fullName: [r.user_firstname, r.user_lastname].filter(Boolean).join(' ') || r.user_name,
    profileImage: r.user_picture || null,
  };
}
function mapPost(r) {
  return {
    id: String(r.post_id),
    author: mapAuthor(r),
    content: r.text || '',
    createdAt: r.time,
    privacy: r.privacy,
    shares: r.shares,
    images: [],
    videos: [],      // filled later
    likes: [],       // optional list
    comments: [],    // optional list
    hasLiked: false, // client uses this
    hasSaved: false, // client uses this
    shareCount: Number(r.shares || 0),
  };
}

// GET /watch  -> video-only feed (public + visible)
router.get('/', ensureAuth, async (req, res) => {
  const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const params = [];
  let where = `p.is_hidden='0' AND p.privacy='public' AND EXISTS
               (SELECT 1 FROM posts_videos vv WHERE vv.post_id = p.post_id)`;

  if (cursor) {
    where += ` AND p.post_id < ?`;
    params.push(cursor);
  }

  try {
    // 1) Base posts (video-only)
    const [rows] = await pool.query(
        `
        SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
               u.user_name, u.user_firstname, u.user_lastname, u.user_picture
          FROM posts p
          JOIN users u ON u.user_id = p.user_id
         WHERE ${where}
         ORDER BY p.post_id DESC
         LIMIT ${limit}
        `,
        params
      );

    if (!rows.length) return res.json({ items: [], nextCursor: null });

    const postIds = rows.map(r => r.post_id);
    const posts = new Map(rows.map(r => [r.post_id, mapPost(r)]));

    // 2) batch fetch videos / likes / comments
    const [
      [vids],
      [likeRows],
      [commentRows],
      [meLikeRows],
      [meSaveRows],
    ] = await Promise.all([
      pool.query(
        `SELECT post_id, source FROM posts_videos WHERE post_id IN (?)`,
        [postIds]
      ),
      pool.query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id IN (?) AND r.reaction='like'`,
        [postIds]
      ),
      pool.query(
        `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                u.user_name, u.user_picture AS profileImage
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type='post' AND c.node_id IN (?)
          ORDER BY c.time ASC`,
        [postIds]
      ),
      // did current user like?
      pool.query(
        `SELECT post_id FROM posts_reactions
          WHERE user_id=? AND reaction='like' AND post_id IN (?)`,
        [req.user.userId, postIds]
      ),
      // has current user saved? (if you track saves separately; if not, skip)
      pool.query(
        `SELECT post_id FROM posts_saves
          WHERE user_id=? AND post_id IN (?)`,
        [req.user.userId, postIds]
      ).catch(() => [[], []]) // ignore if table not present
    ]);

    for (const v of vids) {
      posts.get(v.post_id)?.videos.push(v.source);
    }
    for (const l of likeRows) {
      posts.get(l.post_id)?.likes.push({
        userId: String(l.user_id),
        username: l.user_name,
      });
    }
    for (const c of commentRows) {
      const p = posts.get(c.post_id);
      if (p) {
        p.comments.push({
          id: String(c.comment_id),
          userId: String(c.user_id),
          username: c.user_name,
          profileImage: c.profileImage || null,
          content: c.text,
          createdAt: c.time,
        });
      }
    }
    const meLiked = new Set(meLikeRows.map(r => String(r.post_id)));
    const meSaved = new Set((meSaveRows || []).map?.(r => String(r.post_id)) || []);
    posts.forEach(p => {
      p.hasLiked = meLiked.has(p.id);
      p.hasSaved = meSaved.has(p.id);
    });

    const out = Array.from(posts.values());
    const nextCursor = out.length === limit ? Number(out[out.length - 1].id) : null;
    res.json({ items: out, nextCursor });
  } catch (e) {
    console.error('[GET /watch]', e);
    res.status(500).json({ error: 'Failed to load Watch feed' });
  }
});

module.exports = router;
