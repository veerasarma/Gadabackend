const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { pool } = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const { createNotification } = require('../services/notificationService');
const { checkActivePackage } = require("../services/packageService");

const router = express.Router();

// Helpers to map rows -> API shape
function mapPostRow(p) {
  return {
    id: String(p.post_id),
    author: {
      id: String(p.user_id),
      username: p.authorUsername,
      profileImage: p.authorProfileImage || null
    },
    content: p.text || '',
    createdAt: p.time,
    privacy: p.privacy,
    images: [],
    videos: [],
    likes: [],      // filled later
    comments: [],   // filled later
    shareCount: p.shares || 0,
    hasShared: false, // requires a user-shares table to compute per-user
  };
}

// GET /api/posts  (feed)
router.get('/', ensureAuth, async (req, res) => {
  try {
    // 1) fetch recent posts with author
    // const [posts] = await pool.promise().query(`
    //   SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
    //          u.user_name   AS authorUsername,
    //          u.user_picture AS authorProfileImage
    //     FROM posts p
    //     JOIN users u ON u.user_id = p.user_id
    //    WHERE p.is_hidden = '0'
    //    ORDER BY p.time DESC
    //    LIMIT 100
    // `);
   
    const [posts] = await pool.promise().query(`
        SELECT
        p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
        IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
        u.user_picture AS authorProfileImage
        FROM posts p
        JOIN users u ON u.user_id = p.user_id
        WHERE p.is_hidden = '0'
        ORDER BY p.time DESC
        LIMIT 100;
    `);

    if (!posts.length) return res.json([]);

    const postIds = posts.map(p => p.post_id);

    // 2–6) fetch related in parallel (media, videos, photos, likes, comments)
    const [mediaRows, videoRows, photoRows, likeRows, commentRows] = await Promise.all([
      pool.promise().query(
        `SELECT post_id, source_url, source_type
           FROM posts_media
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT post_id, source
           FROM posts_videos
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      // NEW: photos table
      pool.promise().query(
        `SELECT post_id, album_id, source
           FROM posts_photos
          WHERE post_id IN (?)`,
        [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id IN (?) AND r.reaction = 'like'`,
        [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                u.user_name, u.user_picture AS profileImage
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type = 'post' AND c.node_id IN (?)
          ORDER BY c.time ASC`,
        [postIds]
      ).then(([r]) => r),
    ]);

    // 7) stitch
    const byId = new Map(posts.map(p => [p.post_id, mapPostRow(p)]));

    // images from posts_media
    for (const m of mediaRows) {
      if (m.source_type === 'image') {
        byId.get(m.post_id)?.images.push(m.source_url);
      }
    }
    // NEW: images from posts_photos
    for (const p of photoRows) {
      byId.get(p.post_id)?.images.push(p.source); // same images[] array
      // If you need album info later, you could store alongside, e.g.
      // byId.get(p.post_id)?.albums?.push({ albumId: p.album_id, source: p.source })
    }

    // videos
    for (const v of videoRows) {
      byId.get(v.post_id)?.videos.push(v.source);
    }

    // likes
    for (const l of likeRows) {
      byId.get(l.post_id)?.likes.push({
        userId: String(l.user_id),
        username: l.user_name
      });
    }

    // comments
    for (const c of commentRows) {
      const post = byId.get(c.post_id);
      if (post) {
        post.comments.push({
          id: String(c.comment_id),
          userId: String(c.user_id),
          username: c.user_name,
          profileImage: c.profileImage || null, // fixed alias
          content: c.text,
          createdAt: c.time,
        });
      }
    }

    res.json([...byId.values()]);
  } catch (err) {
    console.error('[GET /posts]', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/posts/:id (detail)
router.get('/:id',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res) => {
    try {
      const { id } = req.params;

      const [[post]] = await pool.promise().query(`
        SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
               u.user_name AS authorUsername,
               u.user_picture AS authorProfileImage
          FROM posts p
          JOIN users u ON u.user_id = p.user_id
         WHERE p.post_id = ?`, [id]);

      if (!post) return res.status(404).json({ error: 'Post not found' });

      const out = mapPostRow(post);

      const [media] = await pool.promise().query(
        `SELECT source_url, source_type FROM posts_media WHERE post_id = ?`, [id]
      );
      out.images = media.filter(m => m.source_type === 'image').map(m => m.source_url);

      const [videos] = await pool.promise().query(
        `SELECT source FROM posts_videos WHERE post_id = ?`, [id]
      );
      out.videos = videos.map(v => v.source);

      const [likes] = await pool.promise().query(
        `SELECT r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id = ? AND r.reaction='like'`, [id]
      );
      out.likes = likes.map(l => ({ userId: String(l.user_id), username: l.user_name }));

      const [comments] = await pool.promise().query(
        `SELECT c.comment_id, c.user_id, c.text, c.time, u.user_name, u.user_picture
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type='post' AND c.node_id = ?
          ORDER BY c.time ASC`, [id]
      );
      out.comments = comments.map(c => ({
        id: String(c.comment_id),
        userId: String(c.user_id),
        username: c.user_name,
        profileImage: c.profile_image || null,
        content: c.text,
        createdAt: c.time
      }));

      res.json(out);
    } catch (err) {
      console.error('[GET /posts/:id] ', err);
      res.status(500).json({ error: 'Failed to load post' });
    }
  }
);

// text -> ['tag1','tag2',...]
function extractHashtags(text) {
  if (!text) return [];
  // Unicode letters/numbers/underscore; up to 256 chars total (matches varchar(256))
  const re = /#([\p{L}\p{N}_]{1,256})/gu;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase(); // normalize case
    if (tag) found.push(tag);
  }
  return Array.from(new Set(found)); // unique
}

router.post(
  '/',
  ensureAuth,
  body('content').optional({ nullable: true }).isString(),
  body('media').isArray().optional(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { userId, content, media = [] } = req.body;

    // only author can create for themselves
    if (String(userId) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // 1) Insert post
      const [r] = await conn.execute(
        `INSERT INTO posts
           (user_id, user_type, post_type, time, privacy, text, is_hidden, in_group, in_event, in_wall,
            reaction_like_count, comments, shares)
         VALUES (?, 'user', 'status', NOW(), 'public', ?, '0', '0', '0', '0', 0, 0, 0)`,
        [userId, content || null]
      );
      const postId = r.insertId;

      // 2) Attach media (images/videos)
      for (const m of media) {
        if (!m?.url || !m?.type) continue;
        if (m.type === 'image') {
          await conn.execute(
            `INSERT INTO posts_media (post_id, source_url, source_provider, source_type)
             VALUES (?, ?, 'upload', 'image')`,
            [postId, m.url]
          );
        } else if (m.type === 'video') {
          await conn.execute(
            `INSERT INTO posts_videos (post_id, category_id, source)
             VALUES (?, 1, ?)`,
            [postId, m.url]
          );
        }
      }

      // 3) Hashtags: extract from content, upsert, link to post
      const tags = extractHashtags(content);
      if (tags.length) {
        // 3a) Fetch existing hashtags
        const placeholders = tags.map(() => '?').join(',');
        const [existingRows] = await conn.query(
          `SELECT hashtag_id, hashtag FROM hashtags WHERE hashtag IN (${placeholders})`,
          tags
        );
        const existing = new Map();
        existingRows.forEach(row => {
          existing.set(String(row.hashtag).toLowerCase(), row.hashtag_id);
        });

        // 3b) Insert new hashtags if needed
        const toInsert = tags.filter(t => !existing.has(t));
        if (toInsert.length) {
          await conn.query(
            `INSERT INTO hashtags (hashtag) VALUES ${toInsert.map(() => '(?)').join(',')}`,
            toInsert
          );
          // Reselect all ids (both existing + new)
          const [afterIns] = await conn.query(
            `SELECT hashtag_id, hashtag FROM hashtags WHERE hashtag IN (${placeholders})`,
            tags
          );
          afterIns.forEach(row => {
            existing.set(String(row.hashtag).toLowerCase(), row.hashtag_id);
          });
        }

        // 3c) Link hashtags to this post (idempotent)
        const hashtagIds = tags
          .map(t => existing.get(t))
          .filter(id => Number.isInteger(id));

        if (hashtagIds.length) {
          const valuesSql = hashtagIds.map(() => '(?, ?, NOW())').join(',');
          const params = [];
          hashtagIds.forEach(hid => {
            params.push(postId, hid);
          });

          // relies on UNIQUE(post_id, hashtag_id) in hashtags_posts
          await conn.query(
            `INSERT IGNORE INTO hashtags_posts (post_id, hashtag_id, created_at)
             VALUES ${valuesSql}`,
            params
          );
        }
      }

      // 4) Fetch enriched post to return (use full name as authorUsername)
      const [rows] = await conn.query(
        `SELECT
           p.post_id,
           p.user_id,
           p.text,
           p.time,
           p.privacy,
           p.shares,
           IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
           u.user_picture AS authorProfileImage
         FROM posts p
         JOIN users u ON u.user_id = p.user_id
         WHERE p.post_id = ?`,
        [postId]
      );
      const post = rows[0];

      const out = mapPostRow(post);

      const [imgs] = await conn.query(
        `SELECT source_url FROM posts_media WHERE post_id=? AND source_type='image'`,
        [postId]
      );
      out.images = imgs.map(i => i.source_url);

      const [vids] = await conn.query(
        `SELECT source FROM posts_videos WHERE post_id=?`,
        [postId]
      );
      out.videos = vids.map(v => v.source);

      //Earning points section for post create 

      const { creditPoints } = require('../utils/points');
     
      const out1 = await creditPoints({
      userId: userId,
      nodeId: postId,
      type: 'post',               // or 'post_create'
      req,                        // so it can read req.system
      checkActivePackage,         // your existing fn
      });
      console.log(out1,'out1out1out1out1')

      // Earning points section for post create

      if (tags && tags.length) out.hashtags = tags;

      await conn.commit();
      res.status(201).json(out);
    } catch (err) {
      await conn.rollback();
      console.error('[POST /posts] ', err);
      res.status(500).json({ error: 'Failed to create post' });
    } finally {
      conn.release();
    }
  }
);

// // POST /api/posts  (create a post)
// router.post('/',
//   ensureAuth,
//   body('content').optional({ nullable: true }).isString(),
//   body('media').isArray().optional(),
//   async (req, res) => {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
//     console.log(req.body,'req.bodyreq.bodyreq.bodyreq.body')
//     const { userId, content, media = [] } = req.body;

//     // sanity: only author can create for themselves (unless you support page/user_type etc)
//     if (String(userId) !== String(req.user.userId)) {
//       return res.status(403).json({ error: 'Forbidden' });
//     }

//     const conn = await pool.promise().getConnection();
//     try {
//       await conn.beginTransaction();

//       // Insert post
//       const [r] = await conn.execute(
//         `INSERT INTO posts
//            (user_id, user_type, post_type, time, privacy, text, is_hidden, in_group, in_event, in_wall,
//             reaction_like_count, comments, shares)
//          VALUES (?, 'user', 'status', NOW(), 'public', ?, '0', '0', '0', '0', 0, 0, 0)`,
//         [userId, content || null]
//       );
//       const postId = r.insertId;

//       // Attach media
//       for (const m of media) {
//         if (!m?.url || !m?.type) continue;
//         if (m.type === 'image') {
//           await conn.execute(
//             `INSERT INTO posts_media (post_id, source_url, source_provider, source_type)
//              VALUES (?, ?, 'upload', 'image')`,
//             [postId, m.url]
//           );
//         } else if (m.type === 'video') {
//           await conn.execute(
//             `INSERT INTO posts_videos (post_id, category_id, source)
//              VALUES (?, 1, ?)`,
//             [postId, m.url]
//           );
//         }
//       }

//       // Fetch enriched post (reuse detail logic quickly)
//       const [[post]] = await conn.query(`
//         SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
//                u.user_name AS authorUsername,
//                u.user_picture AS authorProfileImage
//           FROM posts p
//           JOIN users u ON u.user_id = p.user_id
//          WHERE p.post_id = ?`, [postId]);

//       const out = mapPostRow(post);
//       const [imgs] = await conn.query(
//         `SELECT source_url FROM posts_media WHERE post_id=? AND source_type='image'`, [postId]
//       );
//       out.images = imgs.map(i => i.source_url);
//       const [vids] = await conn.query(
//         `SELECT source FROM posts_videos WHERE post_id=?`, [postId]
//       );
//       out.videos = vids.map(v => v.source);

//       await conn.commit();
//       res.status(201).json(out);
//     } catch (err) {
//       await conn.rollback();
//       console.error('[POST /posts] ', err);
//       res.status(500).json({ error: 'Failed to create post' });
//     } finally {
//       conn.release();
//     }
//   }
// );

// POST /api/posts/:id/react  (toggle like)
router.post('/:id/react',
  ensureAuth,
  param('id').isInt().toInt(),
  body('reaction').optional().isIn(['like']).default('like'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const userId = req.user.userId;
    const reaction = req.body.reaction || 'like';

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT id FROM posts_reactions WHERE post_id=? AND user_id=? AND reaction=?`,
        [id, userId, reaction]
      );
      if (rows.length) {
        // remove like
        await conn.query(`DELETE FROM posts_reactions WHERE id=?`, [rows[0].id]);
        await conn.query(
          `UPDATE posts SET reaction_like_count = GREATEST(reaction_like_count - 1, 0) WHERE post_id=?`,
          [id]
        );
        await conn.commit();
        return res.json({ liked: false });
      } else {
        // add like
        await conn.query(
          `INSERT INTO posts_reactions (post_id, user_id, reaction, reaction_time)
           VALUES (?, ?, 'like', NOW())`,
          [id, userId]
        );
        await conn.query(
          `UPDATE posts SET reaction_like_count = reaction_like_count + 1 WHERE post_id=?`,
          [id]
        );
        //notification part 
        const [[post]] = await conn.query(
          'SELECT user_id AS authorId FROM posts WHERE post_id = ?',
          [id]
        );
        if (!post) return res.status(404).json({ error: 'Post not found' });
        const authorId = Number(post.authorId);
        console.log(post,'postpost')
        if (authorId && authorId !== userId) {
          const payload = {
            recipientId: authorId,
            userId,
            type: 'post_like',
            entityType: 'post',
            entityId: id,
            meta: { id },
          };
    
          if (createNotification) {
            // Use your service (emits socket + returns enriched row)
            createNotification(payload).catch(err =>
              console.error('[notif] post_like helper failed', err)
            );
          } 
        }

        await conn.commit();
        return res.json({ liked: true });
      }
    } catch (err) {
      await conn.rollback();
      console.error('[POST /posts/:id/react] ', err);
      res.status(500).json({ error: 'Failed to toggle reaction' });
    } finally {
      conn.release();
    }
  }
);

// POST /api/posts/:id/comment
router.post('/:id/comment',
  ensureAuth,
  param('id').isInt().toInt(),
  body('content').isString().isLength({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const postId = req.params.id;
    const userId = req.user.userId;
    const { content } = req.body;

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      const [r] = await conn.query(
        `INSERT INTO posts_comments
           (node_id, node_type, user_id, user_type, text, time)
         VALUES (?, 'post', ?, 'user', ?, NOW())`,
        [postId, userId, content]
      );
      const insertedId = r.insertId;

      await conn.query(
        `UPDATE posts SET comments = comments + 1 WHERE post_id = ?`,
        [postId]
      );

      const [[row]] = await conn.query(
        `SELECT c.comment_id, c.user_id, c.text, c.time, u.user_name, u.user_picture
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.comment_id = ?`,
        [insertedId]
      );

       //notification part 
       const [[post]] = await conn.query(
        'SELECT user_id AS authorId FROM posts WHERE post_id = ?',
        [postId]
      );
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const authorId = Number(post.authorId);
      if (authorId && authorId !== userId) {
        const payload = {
          recipientId: authorId,
          userId,
          type: 'post_comment',
          entityType: 'post',
          entityId: postId,
          meta: { postId },
        };
  
        if (createNotification) {
          // Use your service (emits socket + returns enriched row)
          createNotification(payload).catch(err =>
            console.error('[notif] post_comment helper failed', err)
          );
        } 
      }

      await conn.commit();

      res.status(201).json({
        id: String(row.comment_id),
        userId: String(row.user_id),
        username: row.user_name,
        profileImage: row.profile_image || null,
        content: row.text,
        createdAt: row.time
      });
    } catch (err) {
      await conn.rollback();
      console.error('[POST /posts/:id/comment] ', err);
      res.status(500).json({ error: 'Failed to add comment' });
    } finally {
      conn.release();
    }
  }
);

// POST /api/posts/:id/share  (simple counter bump)
router.post('/:id/share',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId  =  req.user.userId;
      await pool.promise().query(`UPDATE posts SET shares = shares + 1 WHERE post_id = ?`, [id]);

      //notification part 
      const [[post]] = await pool.promise().query(
        'SELECT user_id AS authorId FROM posts WHERE post_id = ?',
        [id]
      );
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const authorId = Number(post.authorId);
      console.log(post,'postpost')
      if (authorId && authorId !== userId) {
        const payload = {
          recipientId: authorId,
          userId,
          type: 'post_share',
          entityType: 'post',
          entityId: id,
          meta: { id },
        };
  
        if (createNotification) {
          // Use your service (emits socket + returns enriched row)
          createNotification(payload).catch(err =>
            console.error('[notif] post_share helper failed', err)
          );
        } 
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[POST /posts/:id/share] ', err);
      res.status(500).json({ error: 'Failed to share' });
    }
  }
);

module.exports = router;
