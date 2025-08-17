// routes/reels.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { ensureAuth } = require('../middlewares/auth');
const pool = require('../config/db'); // mysql2/promise pool
const { createNotification } = require('../services/notificationService');

const router = express.Router();

function absUrl(req, rel) {
  if (!rel) return '';
  const s = String(rel);
  if (/^https?:\/\//i.test(s)) return s;
  const cleaned = s.replace(/^\/+/, '');
  return `${req.protocol}://${req.get('host')}/${cleaned.startsWith('uploads/') ? cleaned : `uploads/${cleaned}`}`;
}

/**
 * GET /api/reels
 * Reels are posts where post_type='reel'
 */
router.get('/', ensureAuth, async (req, res) => {
  try {
    const me = Number(req.user.userId);

    const [rows] = await pool.query(`
      SELECT
        p.post_id         AS id,
        p.user_id         AS authorId,
        p.text            AS caption,
        p.time            AS createdAt,
        u.user_name       AS authorUsername,
        u.user_picture    AS authorProfileImage
      FROM posts p
      JOIN users u ON u.user_id = p.user_id
      WHERE p.is_hidden = '0' AND p.post_type = 'reel'
      ORDER BY p.time DESC
      LIMIT 100
    `);

    if (!rows.length) return res.json([]);

    const ids = rows.map(r => r.id);

    // Get videos
    const [vids] = await pool.query(
      `SELECT post_id, source FROM posts_videos WHERE post_id IN (?)`,
      [ids]
    );

    // Map videos by post_id
    const videoMap = new Map();
    for (const v of vids) {
      if (!videoMap.has(v.post_id)) videoMap.set(v.post_id, []);
      videoMap.get(v.post_id).push(v.source); // removed (req, ...)
    }

    // Like counts
    const [likeCounts] = await pool.query(
      `SELECT post_id, COUNT(*) AS cnt
       FROM posts_reactions
       WHERE post_id IN (?) AND reaction = 'like'
       GROUP BY post_id`,
      [ids]
    );
    const likeMap = Object.fromEntries(likeCounts.map(r => [r.post_id, Number(r.cnt) || 0]));

    // My likes
    const [myLikes] = await pool.query(
      `SELECT post_id FROM posts_reactions
       WHERE user_id = ? AND reaction = 'like' AND post_id IN (?)`,
      [me, ids]
    );
    const myLikeSet = new Set(myLikes.map(r => r.post_id));

    // Comment counts
    const [commentCounts] = await pool.query(
      `SELECT node_id AS post_id, COUNT(*) AS cnt
       FROM posts_comments
       WHERE node_type = 'post' AND node_id IN (?)
       GROUP BY node_id`,
      [ids]
    );
    const commentMap = Object.fromEntries(commentCounts.map(r => [r.post_id, Number(r.cnt) || 0]));

    // Share counts
    let shareMap = {};
    try {
      const [shareCounts] = await pool.query(
        `SELECT post_id, COUNT(*) AS cnt
         FROM post_shares
         WHERE post_id IN (?)
         GROUP BY post_id`,
        [ids]
      );
      shareMap = Object.fromEntries(shareCounts.map(r => [r.post_id, Number(r.cnt) || 0]));
    } catch {
      shareMap = {};
    }

    // Prepare final output, filtering out posts with no video URL
    const out = rows
      .map(r => {
        const videoUrl = (videoMap.get(r.id) || [])[0] || null;
        if (!videoUrl) return null; // Skip if videoUrl is null

        return {
          id: r.id,
          videoUrl: videoUrl,
          caption: r.caption || '',
          createdAt: r.createdAt,
          authorId: r.authorId,
          authorUsername: r.authorUsername,
          authorProfileImage: r.authorProfileImage || null,
          likeCount: likeMap[r.id] || 0,
          commentCount: commentMap[r.id] || 0,
          shareCount: shareMap[r.id] || 0,
          hasLiked: myLikeSet.has(r.id),
        };
      })
      .filter(post => post !== null); // Remove nulls

    res.json(out);
  } catch (err) {
    console.error('[GET /reels]', err);
    res.status(500).json({ error: 'Failed to fetch reels' });
  }
});


/**
 * POST /api/reels
 * Create reel as posts row + posts_videos row
 * Accept both absolute and relative URLs (e.g., "uploads/videos/2025/08/x.mp4")
 */
router.post(
  '/',
  ensureAuth,
  body('videoUrl')
    .custom(v => typeof v === 'string' && v.trim().length > 0)
    .withMessage('videoUrl required'),
  body('caption').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = Number(req.user.userId);
    const { videoUrl, caption } = req.body;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [r] = await conn.query(
        `
        INSERT INTO posts
          (user_id, user_type, post_type, time, privacy, text, is_hidden, in_group, in_event, in_wall,
           reaction_like_count, comments, shares)
        VALUES
          (?,       'user',    'reel',   NOW(), 'public', ?,    '0',       '0',      '0',      '0',
           0,                    0,        0)
        `,
        [userId, caption || null]
      );
      const postId = r.insertId;

      await conn.query(
        `INSERT INTO posts_videos (post_id, category_id, source) VALUES (?, 1, ?)`,
        [postId, videoUrl]
      );

      await conn.commit();
      res.status(201).json({ id: postId });
    } catch (err) {
      await conn.rollback();
      console.error('[POST /reels]', err);
      res.status(500).json({ error: 'Failed to create reel' });
    } finally {
      conn.release();
    }
  }
);

/** Toggle like on this reel (posts_reactions) */
router.post('/:id/like', ensureAuth, async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const userId = Number(req.user.userId);

    const [exists] = await pool.query(
      `SELECT 1 FROM posts_reactions
        WHERE post_id=? AND user_id=? AND reaction='like' LIMIT 1`,
      [postId, userId]
    );
    if (exists.length) {
      await pool.query(
        `DELETE FROM posts_reactions WHERE post_id=? AND user_id=? AND reaction='like'`,
        [postId, userId]
      );
      return res.json({ liked: false });
    }
    await pool.query(
      `INSERT INTO posts_reactions (post_id, user_id, reaction, reaction_time) VALUES (?,?, 'like', NOW())`,
      [postId, userId]
    );

     //notification part 
     const [[post]] = await pool.query(
      'SELECT user_id AS authorId FROM posts WHERE post_id = ?',
      [postId]
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const authorId = Number(post.authorId);
    console.log(post,'postpost')
    if (authorId && authorId !== userId) {
      const payload = {
        recipientId: authorId,
        userId,
        type: 'reel_like',
        entityType: 'post',
        entityId: postId,
        meta: { postId },
      };

      if (createNotification) {
        // Use your service (emits socket + returns enriched row)
        createNotification(payload).catch(err =>
          console.error('[notif] reel_like helper failed', err)
        );
      } 
    }
    
    res.json({ liked: true });
  } catch (err) {
    console.error('[POST /reels/:id/like]', err);
    res.status(500).json({ error: 'Failed to like' });
  }
});

/** List comments for this reel from posts_comments */
router.get('/:id/comments', ensureAuth, async (req, res) => {
  try {
    const postId = Number(req.params.id);
 
    const [rows] = await pool.query(
      `
      SELECT
        c.comment_id AS id,
        c.user_id    AS userId,
        u.user_name  AS username,
        c.text       AS content,
        c.time       AS createdAt
      FROM posts_comments c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.node_type='post' AND c.node_id = ?
      ORDER BY c.time ASC
      `,
      [postId]
    );

  
    res.json(rows);
  } catch (err) {
    console.error('[GET /reels/:id/comments]', err);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

/** Add a comment into posts_comments */
router.post(
  '/:id/comments',
  ensureAuth,
  body('content').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const postId = Number(req.params.id);
      const userId = Number(req.user.userId);
      const { content } = req.body;
      

      await pool.query(
        `INSERT INTO posts_comments (node_id, node_type, user_id, text, time)
         VALUES (?, 'post', ?, ?, NOW())`,
        [postId, userId, content]
      );

       //notification part 
      const [[post]] = await pool.query(
        'SELECT user_id AS authorId FROM posts WHERE post_id = ?',
        [postId]
      );
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const authorId = Number(post.authorId);
      console.log(post,'postpost')
      if (authorId && authorId !== userId) {
        const payload = {
          recipientId: authorId,
          userId,
          type: 'reel_comment',
          entityType: 'post',
          entityId: postId,
          meta: { postId },
        };

        if (createNotification) {
          // Use your service (emits socket + returns enriched row)
          createNotification(payload).catch(err =>
            console.error('[notif] reel_comment helper failed', err)
          );
        } 
      }


      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[POST /reels/:id/comments]', err);
      res.status(500).json({ error: 'Failed to comment' });
    }
  }
);

/** Optional: record shares in post_shares if you have it */
router.post('/:id/share', ensureAuth, async (req, res) => {
  try {
    const postId = Number(req.params.id);
    const userId = Number(req.user.userId);
    await pool.query(
      `INSERT INTO post_shares (post_id, user_id, created_at) VALUES (?,?, NOW())`,
      [postId, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /reels/:id/share]', err);
    res.status(500).json({ error: 'Failed to share' });
  }
});

module.exports = router;
