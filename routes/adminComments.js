const express = require('express');
const { query, param, body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
router.use(ensureAuth, requireRole('admin'));

/**
 * GET /api/admin/comments?search=&status=all|deleted&page=1&limit=20
 */
router.get('/',
  [
    query('search').optional().isString().trim(),
    query('status').optional().isIn(['all','deleted']),
    query('page').optional().toInt(),
    query('limit').optional().toInt()
  ],
  async (req, res, next) => {
    try {
      const { search='', status='all', page=1, limit=20 } = req.query;
      const offset = (page - 1) * limit;

      const where = [];
      const args = [];
      if (status === 'deleted') where.push('c.is_deleted=1');
      if (status === 'all')     where.push('1=1');
      if (search) {
        where.push('(c.content LIKE ? OR u.user_name LIKE ?)');
        args.push(`%${search}%`, `%${search}%`);
      }

      const [rows] = await pool.query(
        `
        SELECT c.id, c.post_id AS postId, c.user_id AS userId, u.user_name AS username,
               c.content, c.createdAt AS createdAt, c.is_deleted AS isDeleted
        FROM post_comments c
        JOIN users u ON u.user_id = c.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [...args, Number(limit), Number(offset)]
      );
      res.json({ items: rows, page: Number(page), limit: Number(limit) });
    } catch (e) { next(e); }
  }
);

/** PUT /api/admin/comments/:id/toggle { delete: boolean } */
router.put('/:id/toggle',
  [ param('id').isString(), body('delete').isBoolean() ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { delete: del } = req.body;
      await pool.query(`UPDATE post_comments SET is_deleted=? WHERE id=?`, [del ? 1 : 0, id]);

      await pool.query(
        `INSERT INTO admin_audit (admin_id, action, entity, entity_id, details)
         VALUES (?,?,?,?,JSON_OBJECT('delete', ?))`,
        [req.user.userId, 'comment_toggle', 'comment', String(id), !!del]
      );

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
