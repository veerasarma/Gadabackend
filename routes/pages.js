// routes/pages.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const { checkActivePackage } = require('../services/packageService');

const router = express.Router();

/* ------------------------------ uploads ------------------------------ */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dir = path.join(process.cwd(), 'uploads', 'photos', year, month);
    ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const safe = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const upload = multer({ storage });

function safeFileName(original) {
  const base = String(original || 'file').replace(/[^\w.\-]+/g, '_');
  const ts = Date.now();
  return `${ts}_${base}`;
}
function moveToUploads(tmpPath, finalRelPath) {
  const finalAbs = path.join(process.cwd(), 'uploads', finalRelPath);
  fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
  fs.renameSync(tmpPath, finalAbs);
  return finalRelPath; // stored path relative to /uploads
}

/* ------------------------------ helpers ------------------------------ */
async function getPageByIdOrName(idOrName, conn) {
  if (/^\d+$/.test(String(idOrName))) {
    const [[row]] = await conn.query(`SELECT * FROM pages WHERE page_id=? LIMIT 1`, [Number(idOrName)]);
    return row || null;
  }
  const [[row]] = await conn.query(`SELECT * FROM pages WHERE page_name=? LIMIT 1`, [idOrName]);
  return row || null;
}
async function isPageAdmin(userId, pageId, conn) {
  if (!userId || !pageId) return false;
  const [[row]] = await conn.query(
    `SELECT 1 FROM pages_admins WHERE page_id=? AND user_id=? LIMIT 1`,
    [pageId, userId]
  );
  return !!row;
}


/* ============================== CATEGORIES ============================== */
router.get('/categories', ensureAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT category_id, category_parent_id, category_name, category_order
         FROM pages_categories
        ORDER BY category_parent_id ASC, category_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /pages/categories]', e);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

/* ================================ CREATE ================================ */
router.post('/', ensureAuth, async (req, res) => {
  const userId = Number(req.user.userId);
  const {
    page_name, page_title, page_category, page_country, page_description
  } = req.body || {};
  if (!page_name || !page_title || !page_category || !page_country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [ok] = await conn.query(
      `INSERT INTO pages
         (page_admin, page_category, page_name, page_title, page_country, page_description, page_date)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [userId, page_category, page_name, page_title, page_country, page_description || '']
    );
    const pageId = ok.insertId;

    await conn.query(
      `INSERT IGNORE INTO pages_admins (page_id, user_id) VALUES (?, ?)`,
      [pageId, userId]
    );

    await conn.commit();
    res.status(201).json({ pageId, page_name, page_title });
  } catch (e) {
    await conn.rollback();
    console.error('[POST /pages]', e);
    res.status(500).json({ error: 'Failed to create page' });
  } finally {
    conn.release();
  }
});

/* ============================== LIST (sidebar filters) ============================== */
// GET /api/pages?q=&categoryId=&sort=popular|recent&cursor=&limit=&my=1
router.get('/', ensureAuth, async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
  const sort = (req.query.sort || 'recent').toString();
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;
  const limit = Math.min(24, Math.max(6, Number(req.query.limit) || 12));
  const my = String(req.query.my || '') === '1';

  const conn = await pool.getConnection();
  try {
    const params = [];
    const where = [];
    let fromSql = `FROM pages p`;
    if (my) {
      fromSql += ` LEFT JOIN pages_admins a ON a.page_id = p.page_id`;
      where.push(`(p.page_admin = ? OR a.user_id = ?)`);
      params.push(Number(req.user.userId), Number(req.user.userId));
    }
    if (q) {
      where.push(`(LOWER(p.page_name) LIKE CONCAT(?, '%') OR LOWER(p.page_title) LIKE CONCAT(?, '%'))`);
      params.push(q, q);
    }
    if (categoryId) {
      where.push(`p.page_category = ?`);
      params.push(categoryId);
    }
    if (cursor) {
      where.push(`p.page_id < ?`);
      params.push(cursor);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = sort === 'popular'
      ? `ORDER BY p.page_likes DESC, p.page_id DESC`
      : `ORDER BY p.page_id DESC`;

    const [rows] = await conn.query(
      `
      SELECT p.page_id, p.page_name, p.page_title, p.page_picture, p.page_cover,
             p.page_category, p.page_country, p.page_likes, p.page_date,p.page_boosted, p.page_boosted_by
        ${fromSql}
        ${whereSql}
        ${orderSql}
        LIMIT ${limit}
      `,
      params
    );

    const nextCursor = rows.length === limit ? rows[rows.length - 1].page_id : null;
    res.json({ items: rows, nextCursor });
  } catch (e) {
    console.error('[GET /pages]', e);
    res.status(500).json({ error: 'Failed to load pages' });
  } finally {
    conn.release();
  }
});

// list my incoming invites
router.get('/invites', ensureAuth, async (req, res) => {
    const me = Number(req.user.userId);
    try {
      const [rows] = await pool.query(
        `SELECT i.id AS inviteId, p.page_id, p.page_name, p.page_title, p.page_picture,
                u.user_id AS fromId, u.user_name AS fromUsername, u.user_picture AS fromAvatar
           FROM pages_invites i
           JOIN pages p ON p.page_id = i.page_id
           JOIN users u ON u.user_id = i.from_user_id
          WHERE i.user_id = ?
          ORDER BY i.id DESC
          LIMIT 100`,
        [me]
      );
      res.json(rows);
    } catch (e) {
      console.error('[GET /pages/invites]', e);
      res.status(500).json({ error: 'Failed to load invites' });
    }
  });

/* ============================== PAGE DETAILS ============================== */
router.get('/:idOrName', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const idOrName = req.params.idOrName;

  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const [admins] = await conn.query(
      `SELECT a.user_id, u.user_name, u.user_firstname, u.user_lastname, u.user_picture
         FROM pages_admins a
         JOIN users u ON u.user_id = a.user_id
        WHERE a.page_id = ?`,
      [page.page_id]
    );

    const [[likedRow]] = await conn.query(
      `SELECT 1 FROM pages_likes WHERE page_id=? AND user_id=? LIMIT 1`,
      [page.page_id, me]
    );

    res.json({
      page: {
        id: page.page_id,
        name: page.page_name,
        title: page.page_title,
        page_boosted: page.page_boosted,
        page_boosted_by: page.page_boosted_by,
        picture: page.page_picture,
        cover: page.page_cover,
        categoryId: page.page_category,
        country: page.page_country,
        description: page.page_description,
        likes: page.page_likes,
        date: page.page_date
      },
      admins: admins.map(a => ({
        id: a.user_id,
        fullName: [a.user_firstname, a.user_lastname].filter(Boolean).join(' ') || a.user_name,
        username: a.user_name,
        avatar: a.user_picture || null
      })),
      hasLiked: !!likedRow
    });
  } catch (e) {
    console.error('[GET /pages/:id]', e);
    res.status(500).json({ error: 'Failed to load page' });
  } finally {
    conn.release();
  }
});

/* ============================== MEDIA (admins) ============================== */
router.post('/:idOrName/picture', ensureAuth, upload.single('picture'), async (req, res) => {
  const me = Number(req.user.userId);
  const idOrName = req.params.idOrName;
  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const admin = (page.page_admin === me) || (await isPageAdmin(me, page.page_id, conn));
    if (!admin) return res.status(403).json({ error: 'Forbidden' });

    const rel = path.relative(path.join(process.cwd(), 'uploads'), req.file.path).replace(/\\/g, '/');
    await conn.query(`UPDATE pages SET page_picture=? WHERE page_id=?`, [rel, page.page_id]);
    res.json({ picture: rel });
  } catch (e) {
    console.error('[POST /pages/:id/picture]', e);
    res.status(500).json({ error: 'Failed to update picture' });
  } finally { conn.release(); }
});

router.post('/:idOrName/cover', ensureAuth, upload.single('cover'), async (req, res) => {
  const me = Number(req.user.userId);
  const idOrName = req.params.idOrName;
  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const admin = (page.page_admin === me) || (await isPageAdmin(me, page.page_id, conn));
    if (!admin) return res.status(403).json({ error: 'Forbidden' });

    const rel = path.relative(path.join(process.cwd(), 'uploads'), req.file.path).replace(/\\/g, '/');
    await conn.query(`UPDATE pages SET page_cover=? WHERE page_id=?`, [rel, page.page_id]);
    res.json({ cover: rel });
  } catch (e) {
    console.error('[POST /pages/:id/cover]', e);
    res.status(500).json({ error: 'Failed to update cover' });
  } finally { conn.release(); }
});

/* ============================== LIKE / UNLIKE ============================== */
router.post('/:idOrName/like', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const idOrName = req.params.idOrName;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) { await conn.rollback(); return res.status(404).json({ error: 'Page not found' }); }

    const [[row]] = await conn.query(
      `SELECT id FROM pages_likes WHERE page_id=? AND user_id=? LIMIT 1`,
      [page.page_id, me]
    );

    if (row) {
      await conn.query(`DELETE FROM pages_likes WHERE id=?`, [row.id]);
      await conn.query(`UPDATE pages SET page_likes = GREATEST(page_likes - 1, 0) WHERE page_id=?`, [page.page_id]);
      await conn.commit();
      return res.json({ hasLiked: false });
    } else {
      await conn.query(`INSERT INTO pages_likes (page_id, user_id) VALUES (?, ?)`, [page.page_id, me]);
      await conn.query(`UPDATE pages SET page_likes = page_likes + 1 WHERE page_id=?`, [page.page_id]);
      await conn.commit();
      return res.json({ hasLiked: true });
    }
  } catch (e) {
    await conn.rollback();
    console.error('[POST /pages/:id/like]', e);
    res.status(500).json({ error: 'Failed to like/unlike' });
  } finally {
    conn.release();
  }
});

/* ============================== INVITES ============================== */
// quick user search (for invite modal)
router.get('/users/suggest', ensureAuth, async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    const [rows] = await pool.query(
      `SELECT u.user_id AS id,
              u.user_name AS username,
              CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS fullName,
              u.user_picture AS avatar
         FROM users u
        WHERE LOWER(u.user_name) LIKE CONCAT(?, '%')
           OR LOWER(u.user_firstname) LIKE CONCAT(?, '%')
           OR LOWER(u.user_lastname) LIKE CONCAT(?, '%')
        ORDER BY u.user_id DESC
        LIMIT 10`,
      [q, q, q]
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /pages/users/suggest]', e);
    res.status(500).json({ error: 'Search failed' });
  }
});



// list pending invites for a page (admins only)
router.get('/:idOrName/invites', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const idOrName = req.params.idOrName;
  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const admin = (page.page_admin === me) || (await isPageAdmin(me, page.page_id, conn));
    if (!admin) return res.status(403).json({ error: 'Forbidden' });

    const [rows] = await conn.query(
      `SELECT i.id AS inviteId, i.page_id, i.user_id AS toUserId,
              u.user_name AS toUsername, u.user_picture AS toAvatar,
              i.from_user_id AS fromUserId, uf.user_name AS fromUsername
         FROM pages_invites i
         JOIN users u  ON u.user_id  = i.user_id
         JOIN users uf ON uf.user_id = i.from_user_id
        WHERE i.page_id = ?
        ORDER BY i.id DESC`,
      [page.page_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /pages/:id/invites]', e);
    res.status(500).json({ error: 'Failed to load page invites' });
  } finally {
    conn.release();
  }
});

// create invite (admin)
router.post('/:idOrName/invites', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const target = Number(req.body.userId || 0);
  const idOrName = req.params.idOrName;
  if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Bad user' });

  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const admin = (page.page_admin === me) || (await isPageAdmin(me, page.page_id, conn));
    if (!admin) return res.status(403).json({ error: 'Forbidden' });

    await conn.query(
      `INSERT IGNORE INTO pages_invites (page_id, user_id, from_user_id) VALUES (?, ?, ?)`,
      [page.page_id, target, me]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /pages/:id/invites]', e);
    res.status(500).json({ error: 'Failed to create invite' });
  } finally {
    conn.release();
  }
});

// accept invite
router.post('/:idOrName/invites/:inviteId/accept', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const inviteId = Number(req.params.inviteId);
  const idOrName = req.params.idOrName;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) { await conn.rollback(); return res.status(404).json({ error: 'Page not found' }); }

    const [[inv]] = await conn.query(
      `SELECT id FROM pages_invites WHERE id=? AND page_id=? AND user_id=? LIMIT 1`,
      [inviteId, page.page_id, me]
    );
    if (!inv) { await conn.rollback(); return res.status(404).json({ error: 'Invite not found' }); }

    await conn.query(`DELETE FROM pages_invites WHERE id=?`, [inviteId]);
    await conn.query(`INSERT IGNORE INTO pages_admins (page_id, user_id) VALUES (?, ?)`, [page.page_id, me]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error('[POST /pages/:id/invites/:inv/accept]', e);
    res.status(500).json({ error: 'Failed to accept invite' });
  } finally { conn.release(); }
});

// decline invite
router.post('/:idOrName/invites/:inviteId/decline', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const inviteId = Number(req.params.inviteId);
  const idOrName = req.params.idOrName;
  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const [[inv]] = await conn.query(
      `SELECT id FROM pages_invites WHERE id=? AND page_id=? AND user_id=? LIMIT 1`,
      [inviteId, page.page_id, me]
    );
    if (!inv) return res.status(404).json({ error: 'Invite not found' });

    await conn.query(`DELETE FROM pages_invites WHERE id=?`, [inviteId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /pages/:id/invites/:inv/decline]', e);
    res.status(500).json({ error: 'Failed to decline invite' });
  } finally { conn.release(); }
});

/* ============================== PAGE POSTS ============================== */
router.get('/:idOrName/posts', ensureAuth, async (req, res) => {
  const idOrName = req.params.idOrName;
  const limit = Math.min(25, Math.max(5, Number(req.query.limit) || 10));
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  const conn = await pool.getConnection();
  try {
    const page = await getPageByIdOrName(idOrName, conn);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const params = [page.page_id];
    let where = `p.user_id = ? AND p.user_type = 'page' AND p.is_hidden='0'`;
    if (cursor) { where += ` AND p.post_id < ?`; params.push(cursor); }

    const [rows] = await conn.query(
      `
      SELECT p.post_id, p.user_id, p.text, p.time, p.privacy, p.shares,
             pg.page_name, pg.page_title, pg.page_picture
        FROM posts p
        JOIN pages pg ON pg.page_id = p.user_id
       WHERE ${where}
       ORDER BY p.post_id DESC
       LIMIT ${limit}
      `,
      params
    );

    if (!rows.length) return res.json({ items: [], nextCursor: null });

    const postIds = rows.map(r => r.post_id);

    const [mediaRows, videoRows, photoRows, likeRows, commentRows] = await Promise.all([
      conn.query(`SELECT post_id, source_url, source_type FROM posts_media WHERE post_id IN (?)`, [postIds]).then(([r]) => r),
      conn.query(`SELECT post_id, source FROM posts_videos WHERE post_id IN (?)`, [postIds]).then(([r]) => r),
      conn.query(`SELECT post_id, album_id, source FROM posts_photos WHERE post_id IN (?)`, [postIds]).then(([r]) => r),
      conn.query(
        `SELECT r.post_id, r.user_id, u.user_name
           FROM posts_reactions r
           JOIN users u ON u.user_id = r.user_id
          WHERE r.post_id IN (?) AND r.reaction='like'`,
        [postIds]
      ).then(([r]) => r),
      conn.query(
        `SELECT c.comment_id, c.node_id AS post_id, c.user_id, c.text, c.time,
                u.user_name, u.user_picture AS profileImage
           FROM posts_comments c
           JOIN users u ON u.user_id = c.user_id
          WHERE c.node_type='post' AND c.node_id IN (?)
          ORDER BY c.time ASC`,
        [postIds]
      ).then(([r]) => r),
    ]);

    function makePost(r) {
      return {
        id: String(r.post_id),
        author: {
          id: String(r.user_id),
          username: r.page_name,
          fullName: r.page_title || r.page_name,
          profileImage: r.page_picture || null,
          type: 'page'
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

    for (const m of mediaRows) if (m.source_type === 'image') byId.get(m.post_id)?.images.push(m.source_url);
    for (const ph of photoRows) byId.get(ph.post_id)?.images.push(ph.source);
    for (const v of videoRows) byId.get(v.post_id)?.videos.push(v.source);
    for (const l of likeRows) byId.get(l.post_id)?.likes.push({ userId: String(l.user_id), username: l.user_name });
    for (const c of commentRows) byId.get(c.post_id)?.comments.push({
      id: String(c.comment_id),
      userId: String(c.user_id),
      username: c.user_name,
      profileImage: c.profileImage || null,
      content: c.text,
      createdAt: c.time
    });

    const items = rows.map(r => byId.get(r.post_id));
    const nextCursor = items.length === limit ? items[items.length - 1].id : null;

    res.json({ items, nextCursor });
  } catch (e) {
    console.error('[GET /pages/:id/posts]', e);
    res.status(500).json({ error: 'Failed to load posts' });
  } finally {
    conn.release();
  }
});

// router.post('/:idOrName/posts', ensureAuth, async (req, res) => {
//   const me = Number(req.user.userId);
//   const { content, media = [] } = req.body || {};
//   const idOrName = req.params.idOrName;

//   const conn = await pool.getConnection();
//   try {
//     await conn.beginTransaction();

//     const page = await getPageByIdOrName(idOrName, conn);
//     if (!page) { await conn.rollback(); return res.status(404).json({ error: 'Page not found' }); }

//     const admin = (page.page_admin === me) || (await isPageAdmin(me, page.page_id, conn));
//     if (!admin) { await conn.rollback(); return res.status(403).json({ error: 'Forbidden' }); }

//     const [ins] = await conn.query(
//       `INSERT INTO posts
//          (user_id, user_type, post_type, time, privacy, text, is_hidden, in_group, in_event, in_wall,
//           reaction_like_count, comments, shares)
//        VALUES (?, 'page', 'status', NOW(), 'public', ?, '0', '0', '0', '0', 0, 0, 0)`,
//       [page.page_id, content || null]
//     );
//     const postId = ins.insertId;

//     for (const m of media) {
//       if (!m?.url || !m?.type) continue;
//       if (m.type === 'image') {
//         await conn.query(
//           `INSERT INTO posts_media (post_id, source_url, source_provider, source_type)
//            VALUES (?, ?, 'upload', 'image')`,
//           [postId, m.url]
//         );
//       } else if (m.type === 'video') {
//         await conn.query(
//           `INSERT INTO posts_videos (post_id, category_id, source)
//            VALUES (?, 1, ?)`,
//           [postId, m.url]
//         );
//       }
//     }

//     await conn.commit();
//     res.status(201).json({ postId });
//   } catch (e) {
//     await conn.rollback();
//     console.error('[POST /pages/:id/posts]', e);
//     res.status(500).json({ error: 'Failed to create page post' });
//   } finally {
//     conn.release();
//   }
// });

async function getPageRowByHandle(conn, handle) {
  const [[pg]] = await conn.query(
    `SELECT page_id, page_name
       FROM pages
      WHERE page_name = ?`,
    [handle]
  );
  return pg;
}

// POST /api/pages/:handle/posts  (text + images + videos)
router.post('/:handle/posts',
  ensureAuth,
  upload.fields([{ name: 'images', maxCount: 12 }, { name: 'videos', maxCount: 4 }]),
  async (req, res) => {
    console.log("kfhskdfhsdjfhsdfhsdjhflskdjhf")
    const { handle } = req.params;
    const userId = Number(req.user.userId);
    const content = (req.body.content || '').toString();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1) locate page
      const page = await getPageRowByHandle(conn, handle);
      if (!page) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: 'Page not found' });
      }

      // (Optionally check admin permission for posting as page)
      // if (!await isPageAdmin(conn, page.page_id, userId)) { ... }

      // 2) create a "post" tied to the page (adjust to your schema)
      // Assuming posts has columns: post_id, user_id, page_id, text, post_type, time, is_hidden
      const [postIns] = await conn.query(
        `INSERT INTO posts
           (user_id, user_type, post_type, time, privacy, text, is_hidden, in_group, in_event, in_wall,
            reaction_like_count, comments, shares)
         VALUES (?, 'page', 'status', NOW(), 'public', ?, '0', '0', '0', '0', 0, 0, 0)`,
        [page.page_id, content || null]
      );

      const postId = postIns.insertId;
      console.log(req.files,'req.filesreq.files')
      const images = (req.files?.images || []);
      const videos = (req.files?.videos || []);
      console.log(images,'imagesimages')
      // 3) persist IMAGES into posts_photos (and/or posts_media)
      for (const file of images) {
          const rel = path.join('pages', String(page.page_id), 'images', safeFileName(file.originalname));
          const stored = moveToUploads(file.path, rel);

          await conn.query(
          `INSERT INTO posts_media (post_id, source_url, source_provider, source_type)
          VALUES (?, ?, 'upload', 'image')`,
          [postId, stored]
          );
      }

      // 4) persist VIDEOS into posts_videos (and/or posts_media)
      for (const file of videos) {
        const rel = path.join('pages', String(page.page_id), 'videos', safeFileName(file.originalname));
        const stored = moveToUploads(file.path, rel);

        await conn.query(
                    `INSERT INTO posts_videos (post_id, category_id, source)
                     VALUES (?, 1, ?)`,
                    [postId, stored]
                  );
       
      }

      await conn.commit();
      return res.json({ ok: true, postId });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('[POST /api/pages/:handle/posts]', e);
      return res.status(500).json({ ok: false, error: 'Failed to create page post' });
    } finally {
      conn.release();
      // cleanup tmp files on error paths is handled by rollback; here they’re already moved
    }
  }
);


async function resolvePage(conn, idOrHandle) {
  if (!idOrHandle) return null;
  // numeric id?
  if (/^\d+$/.test(String(idOrHandle))) {
    const [[row]] = await conn.query(
      `SELECT page_id, page_name, page_boosted, page_boosted_by
         FROM pages WHERE page_id=? LIMIT 1`,
      [Number(idOrHandle)]
    );
    return row || null;
  }
  // treat as handle (page_name)
  const [[row]] = await conn.query(
    `SELECT page_id, page_name, page_boosted, page_boosted_by
       FROM pages WHERE page_name=? LIMIT 1`,
    [String(idOrHandle)]
  );
  return row || null;
}


/** POST /pages/:idOrHandle/boost  -> boost a page */
router.post('/:idOrHandle/boost', ensureAuth, async (req, res) => {
  const userId = Number(req.user.userId);
  const idOrHandle = req.params.idOrHandle;

  const conn = await pool.getConnection();
  try {
    const page = await resolvePage(conn, idOrHandle);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const admin = await isPageAdmin(userId,page.page_id,conn);
    if (!admin) return res.status(403).json({ error: 'Only admins can boost a page' });

    // package & quota check
    const info = await checkActivePackage(userId);
    if (!info.active) return res.status(403).json({ error: 'Upgrade your package to boost pages' });

    const enabled = !!info.benefits?.boostPagesEnabled;
    const remaining = Number(info.usage?.boostedPagesRemaining || 0);
    if (!enabled || remaining <= 0) {
      return res.status(403).json({ error: 'You reached the maximum number of boosted pages for your package' });
    }

    if (String(page.page_boosted) === '1') {
      return res.json({ boosted: true }); // already boosted
    }

    await conn.beginTransaction();
    await conn.query(
      `UPDATE pages SET page_boosted='1', page_boosted_by=? WHERE page_id=? AND page_boosted<>'1'`,
      [userId, page.page_id]
    );
    await conn.query(
      `UPDATE users SET user_boosted_pages = user_boosted_pages + 1 WHERE user_id=?`,
      [userId]
    );
    await conn.commit();

    res.json({ boosted: true });
  } catch (e) {
    await conn.rollback();
    console.error('[POST /pages/:id/boost]', e);
    res.status(500).json({ error: 'Failed to boost page' });
  } finally {
    conn.release();
  }
});

/** DELETE /pages/:idOrHandle/boost  -> unboost a page */
router.delete('/:idOrHandle/boost', ensureAuth, async (req, res) => {
  const userId = Number(req.user.userId);
  const idOrHandle = req.params.idOrHandle;

  const conn = await pool.getConnection();
  try {
    const page = await resolvePage(conn, idOrHandle);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const admin = await isPageAdmin(userId,page.page_id,conn);
    if (!admin) return res.status(403).json({ error: 'Only admins can unboost a page' });

    if (String(page.page_boosted) !== '1') {
      return res.json({ boosted: false }); // already not boosted
    }

    await conn.beginTransaction();
    await conn.query(
      `UPDATE pages SET page_boosted='0', page_boosted_by=NULL WHERE page_id=?`,
      [page.page_id]
    );
    // keep counter non-negative
    await conn.query(
      `UPDATE users SET user_boosted_pages = GREATEST(user_boosted_pages - 1, 0) WHERE user_id=?`,
      [userId]
    );
    await conn.commit();

    res.json({ boosted: false });
  } catch (e) {
    await conn.rollback();
    console.error('[DELETE /pages/:id/boost]', e);
    res.status(500).json({ error: 'Failed to unboost page' });
  } finally {
    conn.release();
  }
});

module.exports = router;
