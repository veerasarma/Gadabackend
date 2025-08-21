// routes/hashtag.js
const express = require('express');
const pool = require('../config/db'); // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

function normalizeTag(raw = '') {
  const s = String(raw).trim();
  return s.startsWith('#') ? s.slice(1).toLowerCase() : s.toLowerCase();
}

/**
 * GET /api/hashtag/:tag/summary
 * Returns { tag, hashtagId, counts: { posts, photos }, previews: { photos: string[] } }
 */
router.get('/:tag/summary', ensureAuth, async (req, res) => {
  const tag = normalizeTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Bad tag' });

  const conn = await pool.getConnection();
  try {
    // Find hashtag id
    const [[h]] = await conn.query(
      `SELECT hashtag_id, hashtag FROM hashtags WHERE LOWER(hashtag) = ? LIMIT 1`,
      [tag]
    );

    if (!h) {
      return res.json({
        tag,
        hashtagId: null,
        counts: { posts: 0, photos: 0 },
        previews: { photos: [] }
      });
    }

    const hashtagId = h.hashtag_id;

    // Posts count (only visible posts)
    const [[cnt]] = await conn.query(
      `
      SELECT COUNT(*) AS c
        FROM hashtags_posts hp
        JOIN posts p ON p.post_id = hp.post_id
       WHERE hp.hashtag_id = ? AND p.is_hidden = '0'
      `,
      [hashtagId]
    );

    // Photo preview (latest images from posts_media + posts_photos)
    const [mediaImgs, photoImgs] = await Promise.all([
      conn
        .query(
          `
          SELECT m.source_url AS src
            FROM posts_media m
            JOIN posts p ON p.post_id = m.post_id
            JOIN hashtags_posts hp ON hp.post_id = p.post_id
           WHERE hp.hashtag_id = ?
             AND m.source_type = 'image'
             AND p.is_hidden = '0'
           ORDER BY p.time DESC, m.post_id DESC
           LIMIT 24
          `,
          [hashtagId]
        )
        .then(([r]) => r),
      conn
        .query(
          `
          SELECT ph.source AS src
            FROM posts_photos ph
            JOIN posts p ON p.post_id = ph.post_id
            JOIN hashtags_posts hp ON hp.post_id = p.post_id
           WHERE hp.hashtag_id = ?
             AND p.is_hidden = '0'
           ORDER BY p.time DESC, ph.post_id DESC
           LIMIT 24
          `,
          [hashtagId]
        )
        .then(([r]) => r),
    ]);

    const photos = [...mediaImgs.map(x => x.src), ...photoImgs.map(x => x.src)].slice(0, 12);

    res.json({
      tag,
      hashtagId,
      counts: {
        posts: Number(cnt.c || 0),
        photos: photos.length
      },
      previews: { photos }
    });
  } catch (e) {
    console.error('[GET /hashtag/:tag/summary]', e);
    res.status(500).json({ error: 'Failed to load hashtag summary' });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/hashtag/:tag/posts?cursor=&limit=
 * Cursor = last post_id from previous page; returns same shape as feed/profile posts
 */
router.get('/:tag/posts', ensureAuth, async (req, res) => {
  const tag = normalizeTag(req.params.tag);
  const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  if (!tag) return res.status(400).json({ error: 'Bad tag' });

  const conn = await pool.getConnection();
  try {
    // resolve hashtag_id
    const [[h]] = await conn.query(
      `SELECT hashtag_id FROM hashtags WHERE LOWER(hashtag) = ? LIMIT 1`,
      [tag]
    );
    if (!h) return res.json({ items: [], nextCursor: null });

    const params = [h.hashtag_id];
    let where = `hp.hashtag_id = ? AND p.is_hidden = '0'`;
    if (cursor) {
      where += ` AND p.post_id < ?`;
      params.push(cursor);
    }

    // 1) page of posts for this tag
    const [rows] = await conn.query(
      `
      SELECT
        p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
        u.user_name,
        u.user_firstname,
        u.user_lastname,
        u.user_picture
      FROM hashtags_posts hp
      JOIN posts p ON p.post_id = hp.post_id
      JOIN users u ON u.user_id = p.user_id
      WHERE ${where}
      ORDER BY p.post_id DESC
      LIMIT ${limit}
      `,
      params
    );

    if (!rows.length) {
      return res.json({ items: [], nextCursor: null });
    }

    const postIds = rows.map(r => r.post_id);

    // 2) related data (same as feed)
    const [mediaRows, videoRows, photoRows, likeRows, commentRows] = await Promise.all([
      conn
        .query(
          `SELECT post_id, source_url, source_type
             FROM posts_media
            WHERE post_id IN (?)`,
          [postIds]
        )
        .then(([r]) => r),

      conn
        .query(
          `SELECT post_id, source
             FROM posts_videos
            WHERE post_id IN (?)`,
          [postIds]
        )
        .then(([r]) => r),

      conn
        .query(
          `SELECT post_id, album_id, source
             FROM posts_photos
            WHERE post_id IN (?)`,
          [postIds]
        )
        .then(([r]) => r),

      conn
        .query(
          `SELECT r.post_id, r.user_id, u.user_name
             FROM posts_reactions r
             JOIN users u ON u.user_id = r.user_id
            WHERE r.post_id IN (?) AND r.reaction = 'like'`,
          [postIds]
        )
        .then(([r]) => r),

      conn
        .query(
          `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                  u.user_name, u.user_picture AS profileImage
             FROM posts_comments c
             JOIN users u ON u.user_id = c.user_id
            WHERE c.node_type = 'post' AND c.node_id IN (?)
            ORDER BY c.time ASC`,
          [postIds]
        )
        .then(([r]) => r),
    ]);

    // 3) base mapper
    function makePost(r) {
      return {
        id: String(r.post_id),
        author: {
          id: String(r.user_id),
          username: r.user_name,
          fullName:
            [r.user_firstname, r.user_lastname].filter(Boolean).join(' ') || r.user_name,
          profileImage: r.user_picture || null
        },
        content: r.text || '',
        createdAt: r.time,
        privacy: r.privacy,
        shares: r.shares,
        images: [],
        videos: [],
        likes: [],
        comments: []
      };
    }

    const byId = new Map(rows.map(r => [r.post_id, makePost(r)]));

    for (const m of mediaRows) {
      if (m.source_type === 'image') byId.get(m.post_id)?.images.push(m.source_url);
    }
    for (const ph of photoRows) byId.get(ph.post_id)?.images.push(ph.source);
    for (const v of videoRows) byId.get(v.post_id)?.videos.push(v.source);
    for (const l of likeRows) {
      const p = byId.get(l.post_id);
      if (p) p.likes.push({ userId: String(l.user_id), username: l.user_name });
    }
    for (const c of commentRows) {
      const p = byId.get(c.post_id);
      if (p)
        p.comments.push({
          id: String(c.comment_id),
          userId: String(c.user_id),
          username: c.user_name,
          profileImage: c.profileImage || null,
          content: c.text,
          createdAt: c.time
        });
    }

    const items = rows.map(r => byId.get(r.post_id));
    const nextCursor = items.length === limit ? items[items.length - 1].id : null;

    res.json({ items, nextCursor });
  } catch (e) {
    console.error('[GET /hashtag/:tag/posts]', e);
    res.status(500).json({ error: 'Failed to load hashtag posts' });
  } finally {
    conn.release();
  }
});

module.exports = router;
