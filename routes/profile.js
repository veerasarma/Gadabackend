// routes/profile.js
const express = require('express');
const pool = require('../config/db'); // mysql2 pool (promise)
const { ensureAuth } = require('../middlewares/auth'); 
const { body, validationResult } = require("express-validator");

// ^ implement as a thin wrapper that populates req.user if logged in, but never blocks

const router = express.Router();

/**
 * GET /api/profile/:userId/summary
 * Compact "hero" + counts + previews (friends, photos)
 */
router.get('/:userId/summary', ensureAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Bad user id' });

  const viewerId = req.user?.userId ? Number(req.user.userId) : null;

  const conn = await pool.getConnection();
  try {
    // 1) User core
    const [[user]] = await conn.query(
      `SELECT u.user_id,
              u.user_name,
              u.user_firstname,
              u.user_lastname,
              u.user_picture,
              u.user_cover,
              u.user_biography
         FROM users u
        WHERE u.user_id = ? LIMIT 1`,
      [userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    // 2) Friends count + preview (9)
    // Common 'friends' schema: user_one_id, user_two_id, status (1=accepted)
    const [friendRows] = await conn.query(
      `
      SELECT CASE WHEN f.user_one_id = ? THEN f.user_two_id ELSE f.user_one_id END AS friend_id
        FROM friends f
       WHERE (f.user_one_id = ? OR f.user_two_id = ?)
         AND f.status = 1
       LIMIT 5000
      `,
      [userId, userId, userId]
    );
    const friendIds = friendRows.map(r => Number(r.friend_id));
    const friendsCount = friendIds.length;

    let friendsPreview = [];
    if (friendIds.length) {
      const inPlaceholders = friendIds.slice(0, 9).map(() => '?').join(',');
      const [preview] = await conn.query(
        `SELECT u.user_id,
                u.user_name,
                CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS full_name,
                u.user_picture
           FROM users u
          WHERE u.user_id IN (${inPlaceholders})
          ORDER BY u.user_id DESC`,
        friendIds.slice(0, 9)
      );
      friendsPreview = preview.map(r => ({
        id: r.user_id,
        username: r.user_name,
        fullName: r.full_name || r.user_name,
        avatar: r.user_picture || null
      }));
    }

    // 3) Posts count
    const [[pCount]] = await conn.query(
      `SELECT COUNT(*) AS c FROM posts p
        WHERE p.user_id = ? AND p.is_hidden = '0'`,
      [userId]
    );
    const postsCount = Number(pCount.c || 0);

    // 4) Photos preview (9 latest images from posts)
    const [photos] = await conn.query(
      `
      SELECT m.source_url
        FROM posts_media m
        JOIN posts p ON p.post_id = m.post_id
       WHERE p.user_id = ? AND m.source_type='image'
       ORDER BY p.time DESC, m.post_id DESC
       LIMIT 9
      `,
      [userId]
    );
    const photosPreview = photos.map(x => x.source_url);

    // 5) Relationship (optional)
    let friendship = 'none';
    if (viewerId && viewerId !== userId) {
      const [[fr]] = await conn.query(
        `
        SELECT status
          FROM friends
         WHERE (user_one_id = ? AND user_two_id = ?)
            OR (user_one_id = ? AND user_two_id = ?)
         LIMIT 1
        `,
        [viewerId, userId, userId, viewerId]
      );
      if (fr?.status === 1) friendship = 'friends';
      else if (fr?.status === 0) friendship = 'requested';
      else friendship = 'none';
    } else if (viewerId === userId) {
      friendship = 'me';
    }

    res.json({
      user: {
        id: user.user_id,
        username: user.user_name,
        fullName: [user.user_firstname, user.user_lastname].filter(Boolean).join(' ') || user.user_name,
        avatar: user.user_picture || null,
        cover: user.user_cover || null,
        bio: user.user_bio || ''
      },
      counts: {
        friends: friendsCount,
        posts: postsCount,
        photos: photosPreview.length
      },
      previews: {
        friends: friendsPreview,
        photos: photosPreview
      },
      relationship: friendship
    });
  } catch (e) {
    console.error('[GET /profile/:id/summary]', e);
    res.status(500).json({ error: 'Failed to load profile summary' });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/profile/:userId/posts?limit=10&cursor=POST_ID
 * Cursor-paged posts by that user with media (images/videos)
 */
router.get('/:userId/posts', ensureAuth, async (req, res) => {
    const userId = Number(req.params.userId);
    const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
  
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Bad user id' });
    }
  
    const conn = await pool.getConnection();
    try {
      const params = [userId];
      let where = `p.user_id = ? AND p.is_hidden='0'`;
      if (cursor) {
        where += ` AND p.post_id < ?`;
        params.push(cursor);
      }
  
      // 1) base posts (page)
      const [rows] = await conn.query(
        `
        SELECT
          p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,p.boosted,p.boosted_at,
          u.user_name,
          u.user_firstname,
          u.user_lastname,
          u.user_picture
        FROM posts p
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
  
      // 2) collect ids
      const postIds = rows.map(r => r.post_id);
  
      // 3) fetch related data in parallel (same shape as feed)
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
  
      // 4) base mapper (like your feed's mapPostRow outcome)
      function makePost(r) {
        return {
          id: String(r.post_id),
          boosted: r.boosted,
          boosted_at: r.boosted_at,
          author: {
            id: String(r.user_id),
            username: r.user_name,
            fullName:
              [r.user_firstname, r.user_lastname].filter(Boolean).join(' ') || r.user_name,
            profileImage: r.user_picture || null,
          },
          content: r.text || '',
          createdAt: r.time,
          privacy: r.privacy,
          shares: r.shares,
          images: [],
          videos: [],
          likes: [],     // <-- add likes array
          comments: [],  // <-- add comments array
        };
      }
  
      // 5) stitch like in /posts feed
      const byId = new Map(rows.map(r => [r.post_id, makePost(r)]));
  
      // images (posts_media)
      for (const m of mediaRows) {
        if (m.source_type === 'image') {
          const p = byId.get(m.post_id);
          if (p) p.images.push(m.source_url);
        }
      }
      // extra photos table (posts_photos)
      for (const ph of photoRows) {
        const p = byId.get(ph.post_id);
        if (p) p.images.push(ph.source);
      }
      // videos
      for (const v of videoRows) {
        const p = byId.get(v.post_id);
        if (p) p.videos.push(v.source);
      }
      // likes
      for (const l of likeRows) {
        const p = byId.get(l.post_id);
        if (p) {
          p.likes.push({
            userId: String(l.user_id),
            username: l.user_name,
          });
        }
      }
      // comments
      for (const c of commentRows) {
        const p = byId.get(c.post_id);
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
  
      // 6) preserve page order
      const items = rows.map(r => byId.get(r.post_id));
  
      // 7) next cursor
      const nextCursor = items.length === limit ? items[items.length - 1].id : null;
  
      res.json({ items, nextCursor });
    } catch (e) {
      console.error('[GET /profile/:id/posts]', e);
      res.status(500).json({ error: 'Failed to load posts' });
    } finally {
      conn.release();
    }
  });
  

/**
 * GET /api/profile/:userId/friends?limit=24&cursor=USER_ID
 * Grid-friendly list of friends (cursor = last friend_id returned)
 */
router.get('/:userId/friends', ensureAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  const limit = Math.min(60, Math.max(9, Number(req.query.limit) || 24));
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Bad user id' });

  const conn = await pool.getConnection();
  try {
    const baseRows = await conn.query(
      `
      SELECT CASE WHEN f.user_one_id = ? THEN f.user_two_id ELSE f.user_one_id END AS friend_id
        FROM friends f
       WHERE (f.user_one_id = ? OR f.user_two_id = ?)
         AND f.status = 1
       ORDER BY friend_id DESC
      `,
      [userId, userId, userId]
    );
    let ids = baseRows[0].map(r => Number(r.friend_id));
    if (cursor) ids = ids.filter(id => id < cursor);
    ids = ids.slice(0, limit);

    if (!ids.length) return res.json({ items: [], nextCursor: null });

    const inPlaceholders = ids.map(() => '?').join(',');
    const [urows] = await conn.query(
      `
      SELECT u.user_id, u.user_name,
             CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS full_name,
             u.user_picture
        FROM users u
       WHERE u.user_id IN (${inPlaceholders})
       ORDER BY u.user_id DESC
      `,
      ids
    );

    const items = urows.map(r => ({
      id: r.user_id,
      username: r.user_name,
      fullName: r.full_name || r.user_name,
      avatar: r.user_picture || null
    }));

    const nextCursor = ids.length === limit ? ids[ids.length - 1] : null;

    res.json({ items, nextCursor });
  } catch (e) {
    console.error('[GET /profile/:id/friends]', e);
    res.status(500).json({ error: 'Failed to load friends' });
  } finally {
    conn.release();
  }
});

router.get("/me", ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const [rows] = await pool
      
      .query(
        `SELECT
           user_firstname   AS firstName,
           user_lastname    AS lastName,
           user_gender      AS gender,
           DATE_FORMAT(user_birthdate, '%Y-%m-%d') AS birthdate,
           user_biography   AS bio,
           user_website     AS website,
           user_work_title  AS workTitle,
           user_work_place  AS workPlace,
           user_current_city AS currentCity,
           user_hometown    AS hometown,
           user_social_facebook  AS socialFacebook,
           user_social_twitter   AS socialTwitter,
           user_social_instagram AS socialInstagram,
           user_social_youtube   AS socialYoutube,
           user_social_linkedin  AS socialLinkedin,
           user_privacy_chat   AS privacyChat,
           user_privacy_wall   AS privacyWall,
           user_privacy_photos AS privacyPhotos
         FROM users
         WHERE user_id = ?
         LIMIT 1`,
        [userId]
      );
    res.json(rows[0] || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// PUT /api/profile  -> apply edits (allow-list)
router.put(
  "/",
  ensureAuth,
  body("firstName").optional().isLength({ max: 256 }),
  body("lastName").optional().isLength({ max: 256 }),
  body("gender").optional().isLength({ max: 50 }),
  body("birthdate").optional().isISO8601().toDate(),
  body("bio").optional().isLength({ max: 1000 }),
  body("website").optional().isLength({ max: 256 }),
  body("workTitle").optional().isLength({ max: 256 }),
  body("workPlace").optional().isLength({ max: 256 }),
  body("currentCity").optional().isLength({ max: 256 }),
  body("hometown").optional().isLength({ max: 256 }),
  body("socialFacebook").optional().isLength({ max: 256 }),
  body("socialTwitter").optional().isLength({ max: 256 }),
  body("socialInstagram").optional().isLength({ max: 256 }),
  body("socialYoutube").optional().isLength({ max: 256 }),
  body("socialLinkedin").optional().isLength({ max: 256 }),
  body("privacyChat").optional().isIn(["me", "friends", "public"]),
  body("privacyWall").optional().isIn(["me", "friends", "public"]),
  body("privacyPhotos").optional().isIn(["me", "friends", "public"]),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const userId = Number(req.user.userId);
    const p = req.body || {};

    // map payload -> columns (allow list)
    const updates = {
      user_firstname: p.firstName,
      user_lastname: p.lastName,
      user_gender: p.gender,
      user_birthdate: p.birthdate || null,
      user_biography: p.bio,
      user_website: p.website,
      user_work_title: p.workTitle,
      user_work_place: p.workPlace,
      user_current_city: p.currentCity,
      user_hometown: p.hometown,
      user_social_facebook: p.socialFacebook,
      user_social_twitter: p.socialTwitter,
      user_social_instagram: p.socialInstagram,
      user_social_youtube: p.socialYoutube,
      user_social_linkedin: p.socialLinkedin,
      user_privacy_chat: p.privacyChat,
      user_privacy_wall: p.privacyWall,
      user_privacy_photos: p.privacyPhotos,
    };

    // prune undefined fields so we only update what was sent
    const fields = [];
    const values = [];
    Object.entries(updates).forEach(([col, val]) => {
      if (typeof val !== "undefined") {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    });

    if (!fields.length) return res.json({ ok: true });

    try {
      await pool
        
        .query(
          `UPDATE users SET ${fields.join(", ")} WHERE user_id = ? LIMIT 1`,
          [...values, userId]
        );
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

module.exports = router;
