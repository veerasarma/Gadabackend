const express = require('express');
const { body, validationResult, param } = require('express-validator');
const { pool } = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const { createNotification } = require('../services/notificationService');
const { checkActivePackage } = require("../services/packageService");
const { creditPoints } = require('../utils/points');

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
    boosted: p.boosted,
    boosted_at: p.boosted_at,
    images: [],
    videos: [],
    likes: [],      // filled later
    comments: [],   // filled later
    shareCount: p.shares || 0,
    hasShared: false, // requires a user-shares table to compute per-user
  };
}

// GET /api/posts  (feed)
// router.get('/', ensureAuth, async (req, res) => {
//   try {
   
//     const [posts] = await pool.promise().query(`
//         SELECT
//         p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
//         IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
//         u.user_picture AS authorProfileImage
//         FROM posts p
//         JOIN users u ON u.user_id = p.user_id
//         WHERE p.is_hidden = '0'
//         ORDER BY p.time DESC
//         LIMIT 100;
//     `);

//     if (!posts.length) return res.json([]);

//     const postIds = posts.map(p => p.post_id);

//     // 2–6) fetch related in parallel (media, videos, photos, likes, comments)
//     const [mediaRows, videoRows, photoRows, likeRows, commentRows] = await Promise.all([
//       pool.promise().query(
//         `SELECT post_id, source_url, source_type
//            FROM posts_media
//           WHERE post_id IN (?)`,
//         [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT post_id, source
//            FROM posts_videos
//           WHERE post_id IN (?)`,
//         [postIds]
//       ).then(([r]) => r),

//       // NEW: photos table
//       pool.promise().query(
//         `SELECT post_id, album_id, source
//            FROM posts_photos
//           WHERE post_id IN (?)`,
//         [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT r.post_id, r.user_id, u.user_name
//            FROM posts_reactions r
//            JOIN users u ON u.user_id = r.user_id
//           WHERE r.post_id IN (?) AND r.reaction = 'like'`,
//         [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
//                 u.user_name, u.user_picture AS profileImage
//            FROM posts_comments c
//            JOIN users u ON u.user_id = c.user_id
//           WHERE c.node_type = 'post' AND c.node_id IN (?)
//           ORDER BY c.time ASC`,
//         [postIds]
//       ).then(([r]) => r),
//     ]);

//     // 7) stitch
//     const byId = new Map(posts.map(p => [p.post_id, mapPostRow(p)]));

//     // images from posts_media
//     for (const m of mediaRows) {
//       if (m.source_type === 'image') {
//         byId.get(m.post_id)?.images.push(m.source_url);
//       }
//     }
//     // NEW: images from posts_photos
//     for (const p of photoRows) {
//       byId.get(p.post_id)?.images.push(p.source); // same images[] array
//       // If you need album info later, you could store alongside, e.g.
//       // byId.get(p.post_id)?.albums?.push({ albumId: p.album_id, source: p.source })
//     }

//     // videos
//     for (const v of videoRows) {
//       byId.get(v.post_id)?.videos.push(v.source);
//     }

//     // likes
//     for (const l of likeRows) {
//       byId.get(l.post_id)?.likes.push({
//         userId: String(l.user_id),
//         username: l.user_name
//       });
//     }

//     // comments
//     for (const c of commentRows) {
//       const post = byId.get(c.post_id);
//       if (post) {
//         post.comments.push({
//           id: String(c.comment_id),
//           userId: String(c.user_id),
//           username: c.user_name,
//           profileImage: c.profileImage || null, // fixed alias
//           content: c.text,
//           createdAt: c.time,
//         });
//       }
//     }

//     res.json([...byId.values()]);
//   } catch (err) {
//     console.error('[GET /posts]', err);
//     res.status(500).json({ error: 'Failed to fetch posts' });
//   }
// });

// router.get('/', ensureAuth, async (req, res) => {
//   try {
//     const withPromoted = String(req.query.withPromoted || '0') === '1';

//     // A) boosted pool (48h window)
//     const [boostedRows] = await pool.promise().query(`
//       SELECT
//         p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
//         p.reaction_like_count, p.comments,
//         p.boosted, p.boosted_at,
//         IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
//         u.user_picture AS authorProfileImage
//       FROM posts p
//       JOIN users u ON u.user_id = p.user_id
//       WHERE p.is_hidden = '0'
//         AND p.boosted = '1'
//         AND p.boosted_at IS NOT NULL
//         AND p.boosted_at >= (NOW() - INTERVAL 48 HOUR)
//       ORDER BY p.boosted_at DESC
//       LIMIT 50
//     `);

//     // Pick ONE boosted at random (if any)
//     let promoted = null;
//     if (boostedRows.length > 0) {
//       promoted = boostedRows[Math.floor(Math.random() * boostedRows.length)];
//     }

//     // B) main feed (exclude boosted-in-window), score = recency + engagement (no boost term)
//     const [rows] = await pool.promise().query(`
//       SELECT
//         p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
//         p.reaction_like_count, p.comments,
//         p.boosted, p.boosted_at,
//         IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
//         u.user_picture AS authorProfileImage,

//         TIMESTAMPDIFF(MINUTE, p.time, NOW()) AS age_min,
//         (p.reaction_like_count*0.5 + p.comments*1.0 + p.shares*1.5) AS engagement_raw,

//         (
//           (-0.002 * TIMESTAMPDIFF(MINUTE, p.time, NOW())) +
//           (LOG(1 + (p.reaction_like_count*0.5 + p.comments*1.0 + p.shares*1.5)))
//         ) AS score

//       FROM posts p
//       JOIN users u ON u.user_id = p.user_id
//       WHERE p.is_hidden = '0'
//         AND NOT (
//           p.boosted = '1' AND p.boosted_at IS NOT NULL
//           AND p.boosted_at >= (NOW() - INTERVAL 48 HOUR)
//         )
//       ORDER BY score DESC
//       LIMIT 100
//     `);

//     // If nothing at all, return empty in either format
//     if (!rows.length && !promoted) {
//       return withPromoted ? res.json({ promoted: null, items: [] }) : res.json([]);
//     }

//     // Collect ids for stitching (include promoted if present)
//     const postIds = rows.map(p => p.post_id);
//     if (promoted) postIds.push(promoted.post_id);

//     // 2–6) fetch related in parallel (unchanged)
//     const [mediaRows, videoRows, photoRows, likeRows, commentRows] = await Promise.all([
//       pool.promise().query(
//         `SELECT post_id, source_url, source_type
//            FROM posts_media
//           WHERE post_id IN (?)`, [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT post_id, source
//            FROM posts_videos
//           WHERE post_id IN (?)`, [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT post_id, album_id, source
//            FROM posts_photos
//           WHERE post_id IN (?)`, [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT r.post_id, r.user_id, u.user_name
//            FROM posts_reactions r
//            JOIN users u ON u.user_id = r.user_id
//           WHERE r.post_id IN (?) AND r.reaction = 'like'`, [postIds]
//       ).then(([r]) => r),

//       pool.promise().query(
//         `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
//                 u.user_name, u.user_picture AS profileImage
//            FROM posts_comments c
//            JOIN users u ON u.user_id = c.user_id
//           WHERE c.node_type = 'post' AND c.node_id IN (?)
//           ORDER BY c.time ASC`, [postIds]
//       ).then(([r]) => r),
//     ]);
    

//     // 7) stitch (preserve helpers, but keep boosted flags!)
//     const byId = new Map(
//       rows.map(p => [p.post_id, mapPostRow(p)])
//     );
//     if (promoted && !byId.has(promoted.post_id)) {
//       byId.set(promoted.post_id, mapPostRow(promoted));
//     }

//     for (const m of mediaRows) {
//       if (m.source_type === 'image') byId.get(m.post_id)?.images.push(m.source_url);
//     }
//     for (const p of photoRows) byId.get(p.post_id)?.images.push(p.source);
//     for (const v of videoRows) byId.get(v.post_id)?.videos.push(v.source);
//     for (const l of likeRows) {
//       byId.get(l.post_id)?.likes.push({ userId: String(l.user_id), username: l.user_name });
//     }
//     for (const c of commentRows) {
//       const post = byId.get(c.post_id);
//       if (post) {
//         post.comments.push({
//           id: String(c.comment_id),
//           userId: String(c.user_id),
//           username: c.user_name,
//           profileImage: c.profileImage || null,
//           content: c.text,
//           createdAt: c.time,
//         });
//       }
//     }

//     // Output
//     if (withPromoted) {
//       const promotedOut = promoted ? byId.get(promoted.post_id) : null;
//       const itemsOut = rows.map(p => byId.get(p.post_id)); // keep ranking order
//       return res.json({ promoted: promotedOut, items: itemsOut });
//     } else {
//       // backward compatible: return plain array (just the main list)
//       return res.json(rows.map(p => byId.get(p.post_id)));
//     }
//   } catch (err) {
//     console.error('[GET /posts]', err);
//     res.status(500).json({ error: 'Failed to fetch posts' });
//   }
// });

router.get('/', ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.userId || 0);           // for myReaction / hasViewed
    const withPromoted = String(req.query.withPromoted || '0') === '1';

    // A) boosted pool (48h window)
    const [boostedRows] = await pool.promise().query(`
      SELECT
        p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
        p.reaction_like_count, p.comments,
        p.boosted, p.boosted_at,
        IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
        u.user_picture AS authorProfileImage
      FROM posts p
      JOIN users u ON u.user_id = p.user_id
      WHERE p.is_hidden = '0'
        AND p.boosted = '1'
        AND p.boosted_at IS NOT NULL
        AND p.boosted_at >= (NOW() - INTERVAL 48 HOUR)
      ORDER BY p.boosted_at DESC
      LIMIT 50
    `);

    // Pick ONE boosted at random (if any)
    let promoted = null;
    if (boostedRows.length > 0) {
      promoted = boostedRows[Math.floor(Math.random() * boostedRows.length)];
    }

    // B) main feed (exclude boosted-in-window)
    const [rows] = await pool.promise().query(`
      SELECT
        p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
        p.reaction_like_count, p.comments,
        p.boosted, p.boosted_at,
        IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
        u.user_picture AS authorProfileImage,

        TIMESTAMPDIFF(MINUTE, p.time, NOW()) AS age_min,
        (p.reaction_like_count*0.5 + p.comments*1.0 + p.shares*1.5) AS engagement_raw,

        (
          (-0.002 * TIMESTAMPDIFF(MINUTE, p.time, NOW())) +
          (LOG(1 + (p.reaction_like_count*0.5 + p.comments*1.0 + p.shares*1.5)))
        ) AS score

      FROM posts p
      JOIN users u ON u.user_id = p.user_id
      WHERE p.is_hidden = '0'
        AND NOT (
          p.boosted = '1' AND p.boosted_at IS NOT NULL
          AND p.boosted_at >= (NOW() - INTERVAL 48 HOUR)
        )
      ORDER BY score DESC
      LIMIT 100
    `);

    // If nothing at all, return empty in either format
    if (!rows.length && !promoted) {
      return withPromoted ? res.json({ promoted: null, items: [] }) : res.json([]);
    }

    // Collect ids for stitching (include promoted if present)
    const postIds = rows.map(p => p.post_id);
    if (promoted) postIds.push(promoted.post_id);

    // 2–? ) fetch related in parallel (ADDED 2 extra queries for VIEWS)
    const [
      mediaRows, videoRows, photoRows, likeRows, commentRows,
      reactAggRows, myReactRows,
      viewAggRows, viewMineRows
    ] = await Promise.all([
      pool.promise().query(
        `SELECT post_id, source_url, source_type
           FROM posts_media
          WHERE post_id IN (?)`, [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT post_id, source
           FROM posts_videos
          WHERE post_id IN (?)`, [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT post_id, album_id, source
           FROM posts_photos
          WHERE post_id IN (?)`, [postIds]
      ).then(([r]) => r),

      // existing "likes" fetch (for backward compat / older UI):
      pool.promise().query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id IN (?) AND r.reaction = 'like'`, [postIds]
      ).then(([r]) => r),

      pool.promise().query(
        `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                u.user_name, u.user_picture AS profileImage
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type = 'post' AND c.node_id IN (?)
          ORDER BY c.time ASC`, [postIds]
      ).then(([r]) => r),

      // aggregated reactions per post (all types)
      pool.promise().query(
        `SELECT post_id, reaction, COUNT(*) AS c
           FROM posts_reactions
          WHERE post_id IN (?)
          GROUP BY post_id, reaction`, [postIds]
      ).then(([r]) => r),

      // the current viewer's reaction per post
      pool.promise().query(
        `SELECT post_id, reaction
           FROM posts_reactions
          WHERE post_id IN (?) AND user_id = ?`, [postIds, userId || -1]
      ).then(([r]) => r),

      // ---- NEW: total views per post
      pool.promise().query(
        `SELECT post_id, COUNT(*) AS views
           FROM posts_views
          WHERE post_id IN (?)
          GROUP BY post_id`, [postIds]
      ).then(([r]) => r),

      // ---- NEW: which posts the current user has viewed
      pool.promise().query(
        `SELECT post_id
           FROM posts_views
          WHERE post_id IN (?) AND user_id = ?`, [postIds, userId || -1]
      ).then(([r]) => r),
    ]);

    // 8) stitch (preserve helpers, but keep boosted flags!)
    const byId = new Map(rows.map(p => [p.post_id, mapPostRow(p)]));
    if (promoted && !byId.has(promoted.post_id)) {
      byId.set(promoted.post_id, mapPostRow(promoted));
    }

    for (const m of mediaRows) {
      if (m.source_type === 'image') byId.get(m.post_id)?.images.push(m.source_url);
    }
    for (const ph of photoRows) byId.get(ph.post_id)?.images.push(ph.source);
    for (const v of videoRows) byId.get(v.post_id)?.videos.push(v.source);

    // existing likes list (kept for backward compatibility)
    for (const l of likeRows) {
      byId.get(l.post_id)?.likes.push({ userId: String(l.user_id), username: l.user_name });
    }

    for (const c of commentRows) {
      const post = byId.get(c.post_id);
      if (post) {
        post.comments.push({
          id: String(c.comment_id),
          userId: String(c.user_id),
          username: c.user_name,
          profileImage: c.profileImage || null,
          content: c.text,
          createdAt: c.time,
        });
      }
    }

    // ---- reactions aggregation + my reaction ----
    const rxAggMap = new Map();
    for (const r of reactAggRows) {
      const arr = rxAggMap.get(r.post_id) || [];
      arr.push({ reaction: r.reaction, c: Number(r.c || 0) });
      rxAggMap.set(r.post_id, arr);
    }
    const myRxMap = new Map();
    for (const r of myReactRows) {
      myRxMap.set(r.post_id, r.reaction);
    }

    // ---- NEW: views totals + did current user view ----
    const viewsById = new Map();
    for (const v of viewAggRows) {
      viewsById.set(Number(v.post_id), Number(v.views || 0));
    }
    const viewedSet = new Set(viewMineRows.map(v => Number(v.post_id)));


    for (const postId of postIds) {
      const post = byId.get(postId);
      if (!post) continue;

      // reactions
      post.reactions  = rxAggMap.get(postId) || [];
      post.myReaction = myRxMap.get(postId) || null;

      // Backward-compat counters
      const summed = post.reactions.reduce((sum, r) => sum + Number(r.c || 0), 0);
      post.likesCount = summed > 0 ? summed : (Array.isArray(post.likes) ? post.likes.length : 0);
      post.hasLiked   = Boolean(post.myReaction) ||
                        (Array.isArray(post.likes) && post.likes.some(l => Number(l.userId) === userId));

      // NEW: views
      post.views     = viewsById.get(postId) || 0;                 // total views
      post.hasViewed = viewedSet.has(Number(postId));              // current user viewed?
    }

    // Output
    if (withPromoted) {
      const promotedOut = promoted ? byId.get(promoted.post_id) : null;
      const itemsOut = rows.map(p => byId.get(p.post_id)); // keep ranking order
      return res.json({ promoted: promotedOut, items: itemsOut });
    } else {
      return res.json(rows.map(p => byId.get(p.post_id)));
    }
  } catch (err) {
    console.error('[GET /posts]', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

router.get("/getreactions", ensureAuth, async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT reaction, title, color, image
         FROM system_reactions
        WHERE enabled = '1'
        ORDER BY reaction_order ASC`
    );
    res.json({ data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load reactions" });
  }
});

router.post(
  "/edit/:id",
  ensureAuth,
  body("text").optional().isString().trim().isLength({ min: 1, max: 5000 }),
  body("privacy").optional().isIn(["public", "friends", "only_me"]),
  body("images").optional().isArray({ max: 10 }),
  body("images.*").optional().isString().trim(),
  body("videos").optional().isArray({ max: 5 }),
  body("videos.*").optional().isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const postId = Number(req.params.id);
    const userId = Number(req.user.userId || 0);
    const { text, privacy, images, videos } = req.body;

    if (!text && !privacy && !images && !videos) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // 1) Authorize (locking row while we edit)
      const [rows] = await conn.query(
        "SELECT user_id FROM posts WHERE post_id = ? FOR UPDATE",
        [postId]
      );
      const row = rows[0];
      if (!row) {
        await conn.rollback();
        return res.status(404).json({ error: "Post not found" });
      }
      if (Number(row.user_id) !== userId) {
        await conn.rollback();
        return res.status(403).json({ error: "You can only edit your own post" });
      }

      // 2) Update base fields
      const setParts = [];
      const setVals = [];
      if (typeof text === "string") {
        setParts.push("text = ?");
        setVals.push(text.trim());
      }
      if (typeof privacy === "string") {
        setParts.push("privacy = ?");
        setVals.push(privacy);
      }
      if (setParts.length) {
        // Track edit state if you keep such columns (safe if missing)
        // setParts.push("edited = 1", "edited_at = NOW()");
        await conn.query(
          `UPDATE posts SET ${setParts.join(", ")} WHERE post_id = ?`,
          [...setVals, postId]
        );
      }

      // 3) Optional: replace media (ONLY if arrays provided)
      if (Array.isArray(images)) {
        await conn.query("DELETE FROM posts_media WHERE post_id = ? AND source_type = 'image'", [postId]);
        if (images.length) {
          const values = images.map((src) => [postId, src, "image"]);
          await conn.query(
            "INSERT INTO posts_media (post_id, source_url, source_type) VALUES ?",
            [values]
          );
        }
      }
      if (Array.isArray(videos)) {
        await conn.query("DELETE FROM posts_videos WHERE post_id = ?", [postId]);
        if (videos.length) {
          const vvalues = videos.map((src) => [postId, src]);
          await conn.query(
            "INSERT INTO posts_videos (post_id, source) VALUES ?",
            [vvalues]
          );
        }
      }

      await conn.commit();

      // 4) Return updated post (minimal shape used by your feed)
      const [[updated]] = await Promise.all([
        conn.query(
          `SELECT
             p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
             p.reaction_like_count, p.comments,
             IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS authorUsername,
             u.user_picture AS authorProfileImage
           FROM posts p
           JOIN users u ON u.user_id = p.user_id
          WHERE p.post_id = ?`,
          [postId]
        ),
      ]);

      // Attach media (optional, small follow-ups)
      const [media]  = await conn.query(
        "SELECT source_url, source_type FROM posts_media WHERE post_id = ? AND source_type = 'image'",
        [postId]
      );
      const [videosR] = await conn.query(
        "SELECT source FROM posts_videos WHERE post_id = ?",
        [postId]
      );

      const out = {
        ...updated[0],
        images: (media || []).filter(m => m.source_type === "image").map(m => m.source_url),
        videos: (videosR || []).map(v => v.source),
      };

      return res.json({ ok: true, post: out });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error("[PATCH /posts/:id]", e);
      return res.status(500).json({ error: "Failed to update post" });
    } finally {
      conn.release();
    }
  }
);


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
    // console.log(req.body.reaction,'req.body.reaction')
    // const errors = validationResult(req);
    // if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    if (!id || !req.body.reaction) {
      return res.status(400).json({ error: "Missing postId or reaction" });
    }

    const userId = req.user.userId;
    const reaction = req.body.reaction || 'like';

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

        // add like
        const [rx] = await conn.query(
          `SELECT reaction FROM system_reactions WHERE reaction = ? AND enabled = '1' LIMIT 1`,
          [reaction]
        );
        if (!rx[0]) return res.status(400).json({ error: "Unknown reaction" });
    
        await conn.query(
          `INSERT INTO posts_reactions (post_id, user_id, reaction, reaction_time, points_earned)
           VALUES (?, ?, ?, NOW(), '1')
           ON DUPLICATE KEY UPDATE reaction = VALUES(reaction), reaction_time = NOW()`,
          [id, userId, reaction]
        );
    
        const [counts] = await conn.query(
          `SELECT reaction, COUNT(*) AS c
             FROM posts_reactions
            WHERE post_id = ?
            GROUP BY reaction`,
          [id]
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
        console.log(authorId,'authorId',userId)
        if (authorId && authorId !== userId) {
          const payload = {
            recipientId: authorId,
            userId,
            type: 'post_like',
            entityType: 'post',
            entityId: id,
            meta: { id },
          };
    
          console.log("notification section1111")
          if (createNotification) {
            console.log("notification section")
            // Use your service (emits socket + returns enriched row)
            createNotification(payload).catch(err =>
              console.error('[notif] post_like helper failed', err)
            );
          } 

            //Earning points section for post create 
            const out1 = await creditPoints({
            userId: authorId,
            nodeId: id,
            type: 'posts_reactions',               // or 'post_create'
            req,                        // so it can read req.system
            checkActivePackage,         // your existing fn
            });
            // console.log(out1,'out1out1out1out1')
          
 
       // Earning points section for post create
        }

        await conn.commit();
        return res.json({ liked: true });
      
    } catch (err) {
      await conn.rollback();
      console.error('[POST /posts/:id/react] ', err);
      res.status(500).json({ error: 'Failed to toggle reaction' });
    } finally {
      conn.release();
    }
  }
);

router.delete("/:id/react", ensureAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = Number(req.user.userId);
  if (!postId) return res.status(400).json({ error: "Missing postId" });
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM posts_reactions WHERE post_id = ? AND user_id = ?`,
      [postId, userId]
    );

    const [counts] = await conn.query(
      `SELECT reaction, COUNT(*) AS c
         FROM posts_reactions
        WHERE post_id = ?
        GROUP BY reaction`,
      [postId]
    );
    await conn.commit();
    res.json({ ok: true, myReaction: null, counts });
  } catch (e) {
    console.error(e);
    await conn.commit();
    res.status(500).json({ error: "Failed to unreact" });
  }
});


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
      
      //Earning points section for post create 
      
      if (authorId && authorId !== userId) {
       const out1 = await creditPoints({
        userId: authorId,
        nodeId: insertedId,
        type: 'post_comment',               // or 'post_create'
        req,                        // so it can read req.system
        checkActivePackage,         // your existing fn
      });
      console.log(out1,'out1out1out1out1')
    }

      // Earning points section for post create

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

// POST /posts/:id/boost  -> boost this post
router.post('/:id/boost', ensureAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = Number(req.user.userId);

  if (!Number.isFinite(postId)) return res.status(400).json({ error: 'Bad post id' });

  const conn = await pool.promise().getConnection();
  try {
    const [[post]] = await conn.query(
      `SELECT post_id, user_id, in_group, in_event, boosted, time
         FROM posts
        WHERE post_id = ? LIMIT 1`,
      [postId]
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (String(post.user_id) !== String(userId)) return res.status(403).json({ error: 'Forbidden' });

    // disallow boosting from group/event posts (mirrors PHP)
    if (String(post.in_group) === '1' || String(post.in_event) === '1') {
      return res.status(400).json({ error: "You can't boost a post from a group or event" });
    }

    // require active package
    const pkg = await checkActivePackage(userId).catch(() => ({ active: false }));
    if (!pkg?.active) {
      return res.status(403).json({ error: 'Upgrade your package to boost posts' });
    }
    if (!pkg?.canBoostPosts) {
      return res.status(403).json({ error: 'You have reached the limit to boost the post' });
    }

    // (Optional) if you enforce a quota, check it here using req.system and a counter
    // const sys = req.system || {};
    // const limit = pkg.active ? Number(sys.boost_posts_limit_pro ?? 9999) : Number(sys.boost_posts_limit_user ?? 0);
    // const [[{ count }]] = await conn.query(`SELECT user_boosted_posts AS count FROM users WHERE user_id=?`, [userId]);
    // if (count >= limit) return res.status(403).json({ error: 'Reached max boosted posts' });

    if (String(post.boosted) === '1') {
      return res.status(200).json({ boosted: true }); // already boosted
    }

    await conn.beginTransaction();

    const [r] = await conn.query(
      `UPDATE posts SET boosted='1',boosted_at=NOW(), boosted_by=? WHERE post_id=? AND boosted<>'1'`,
      [userId, postId]
    );
    if (r.affectedRows > 0) {
      // keep a counter if you use it
      await conn.query(
        `UPDATE users SET user_boosted_posts = user_boosted_posts + 1 WHERE user_id=?`,
        [userId]
      );
    }

    await conn.commit();
    res.json({ boosted: true });
  } catch (e) {
    await conn.rollback();
    console.error('[POST /posts/:id/boost]', e);
    res.status(500).json({ error: 'Failed to boost post' });
  } finally {
    conn.release();
  }
});

// DELETE /posts/:id/boost  -> unboost
router.delete('/:id/boost', ensureAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = Number(req.user.userId);

  if (!Number.isFinite(postId)) return res.status(400).json({ error: 'Bad post id' });

  const conn = await pool.promise().getConnection();
  try {
    const [[post]] = await conn.query(
      `SELECT post_id, user_id, boosted, boosted_by FROM posts WHERE post_id=? LIMIT 1`,
      [postId]
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (String(post.user_id) !== String(userId)) return res.status(403).json({ error: 'Forbidden' });

    await conn.beginTransaction();

    const [r] = await conn.query(
      `UPDATE posts SET boosted='0', boosted_by=NULL, boosted_at=NULL WHERE post_id=? AND boosted='1'`,
      [postId]
    );
    if (r.affectedRows > 0) {
      // optional: keep counter non-negative
      await conn.query(
        `UPDATE users SET user_boosted_posts = GREATEST(user_boosted_posts - 1, 0) WHERE user_id=?`,
        [userId]
      );
    }

    await conn.commit();
    res.json({ boosted: false });
  } catch (e) {
    await conn.rollback();
    console.error('[DELETE /posts/:id/boost]', e);
    res.status(500).json({ error: 'Failed to unboost post' });
  } finally {
    conn.release();
  }
});




module.exports = router;
