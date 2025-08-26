const express = require('express');
const { query, param, body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
router.use(ensureAuth, requireRole('admin'));

function requireAdmin(req, res, next) {
  const role = String(req.user?.roles || 'user').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

/**
 * PUT /api/admin/posts/:id/visibility { action: remove|restore|shadow|unshadow }
 */
router.delete(
  '/:id',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const postId = req.params.id;
      const userId = String(req.user.userId || '');
      const role = String(req.user.roles || 'user'); // 'admin' or 'user'

      const conn = await pool.getConnection();
      try {
        // 1) sanity: post exists?
        const [[post]] = await conn.query(
          `SELECT post_id, user_id FROM posts WHERE post_id = ? LIMIT 1`,
          [postId]
        );
        if (!post) {
          conn.release();
          return res.status(404).json({ error: 'Post not found' });
        }

        // 2) permission: author or admin only
        const isOwner = String(post.user_id) === userId;
        const isAdmin = role === 'admin';
        if (!isOwner && !isAdmin) {
          conn.release();
          return res.status(403).json({ error: 'Forbidden' });
        }

        await conn.beginTransaction();

        // 3) delete dependent rows (if you don't have ON DELETE CASCADE)
        await conn.query(`DELETE FROM posts_media      WHERE post_id = ?`, [postId]);
        await conn.query(`DELETE FROM posts_videos     WHERE post_id = ?`, [postId]);
        await conn.query(`DELETE FROM posts_photos     WHERE post_id = ?`, [postId]);
        await conn.query(`DELETE FROM posts_reactions  WHERE post_id = ?`, [postId]);
        await conn.query(
          `DELETE FROM posts_comments
            WHERE node_type = 'post' AND node_id = ?`,
          [postId]
        );
        await conn.query(`DELETE FROM hashtags_posts   WHERE post_id = ?`, [postId]);

        // 4) finally, delete the post
        await conn.query(`DELETE FROM posts WHERE post_id = ?`, [postId]);

        await conn.commit();
        res.json({ ok: true, deleted: String(postId) });
      } catch (e) {
        try { await conn.rollback(); } catch {}
        next(e);
      } finally {
        conn.release();
      }
    } catch (e) {
      next(e);
    }
  }
);

router.get('/metrics', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        /* all posts */
        (SELECT COUNT(*) FROM posts) AS totalPosts,

        /* comments on posts */
        (SELECT COUNT(*) FROM posts_comments WHERE node_type = 'post') AS totalComments,

        /* all reactions on posts */
        (SELECT COUNT(*) FROM posts_reactions) AS totalReactions
    `);

    const r = rows[0] || {};
    res.json({
      totalPosts: Number(r.totalPosts || 0),
      totalComments: Number(r.totalComments || 0),
      totalReactions: Number(r.totalReactions || 0),
    });
  } catch (e) {
    next(e);
  }
});


/**
 * GET /api/admin/posts?status=all|visible|shadow|deleted&search=&page=1&limit=20
 */
router.get('/',
    [
      query('status').optional().isIn(['all','visible','shadow','deleted']),
      query('search').optional().isString().trim(),
      query('page').optional().toInt(),
      query('limit').optional().toInt()
    ],
    async (req, res, next) => {
      try {
        const { status='all', search='', page=1, limit=20 } = req.query;
        const offset = (page - 1) * limit;
  
        const where = [];
        const args = [];
  
        if (status === 'visible') where.push('p.is_deleted = 0 AND p.is_shadow_hidden = 0');
        else if (status === 'shadow')  where.push('p.is_deleted = 0 AND p.is_shadow_hidden = 1');
        else if (status === 'deleted') where.push('p.is_deleted = 1');
  
        if (search) {
          where.push('(p.text LIKE ? OR u.user_name LIKE ?)');
          args.push(`%${search}%`, `%${search}%`);
        }
  
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  
        // 1) total count
        const [[countRow]] = await pool.query(
          `SELECT COUNT(*) AS total
             FROM posts p
             JOIN users u ON u.user_id = p.user_id
             ${whereSql}`,
          args
        );
        const total = Number(countRow.total) || 0;
        const totalPages = Math.max(1, Math.ceil(total / Number(limit)));
  
        // 2) page of items
        const [rows] = await pool.query(
          `
          SELECT
            p.post_id AS id,
            p.user_id AS authorId,
            u.user_name AS authorUsername,
            p.text AS content,
            p.time AS createdAt,
            p.post_type AS type,
            (SELECT COUNT(*) FROM posts_reactions pl WHERE pl.post_id=p.post_id) AS likeCount,
            (SELECT COUNT(*) FROM posts_comments pc WHERE pc.node_id=p.post_id ) AS commentCount
          FROM posts p
          JOIN users u ON u.user_id = p.user_id
          ${whereSql}
          ORDER BY p.time DESC
          LIMIT ? OFFSET ?
          `,
          [...args, Number(limit), Number(offset)]
        );
  
        res.json({
          items: rows,
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages,
          hasPrev: Number(page) > 1,
          hasNext: Number(page) < totalPages
        });
      } catch (e) { next(e); }
    }
  );



module.exports = router;
