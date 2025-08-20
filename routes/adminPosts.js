const express = require('express');
const { query, param, body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
router.use(ensureAuth, requireRole('admin'));

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
          where.push('(p.content LIKE ? OR u.user_name LIKE ?)');
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

/**
 * PUT /api/admin/posts/:id/visibility { action: remove|restore|shadow|unshadow }
 */
router.put('/:id/visibility',
  [
    param('id').isString(),
    body('action').isIn(['remove','restore','shadow','unshadow'])
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const { action } = req.body;

      const maps = {
        remove:   ['is_deleted=1, is_shadow_hidden=is_shadow_hidden'],
        restore:  ['is_deleted=0'],
        shadow:   ['is_deleted=0, is_shadow_hidden=1'],
        unshadow: ['is_deleted=0, is_shadow_hidden=0']
      };
      const set = maps[action][0];

      await pool.query(`UPDATE posts SET ${set} WHERE id = ?`, [id]);

      // audit
      await pool.query(
        `INSERT INTO admin_audit (admin_id, action, entity, entity_id, details)
         VALUES (?,?,?,?,JSON_OBJECT('action', ?))`,
        [req.user.userId, 'post_visibility', 'post', String(id), action]
      );

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
