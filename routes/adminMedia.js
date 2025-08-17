const express = require('express');
const { query, param, body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
router.use(ensureAuth, requireRole('admin'));

/**
 * GET /api/admin/media?type=all|image|video&status=all|ok|down&page=1&limit=40
 * Combines post_media and group_post_media into unified feed
 */
router.get('/',
  [
    query('type').optional().isIn(['all','image','video']),
    query('status').optional().isIn(['all','ok','down']),
    query('page').optional().toInt(),
    query('limit').optional().toInt()
  ],
  async (req, res, next) => {
    try {
      const { type='all', status='all', page=1, limit=40 } = req.query;
      const offset = (page - 1) * limit;

      const cond = [];
      if (type !== 'all') cond.push(`type='${type}'`);
      if (status === 'ok')  cond.push(`taken_down=0`);
      if (status === 'down')cond.push(`taken_down=1`);
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

      const [rows] = await pool.query(
        `
        SELECT id, post_id AS ownerId, 'post' AS source, url, type, taken_down AS takenDown, created_at AS createdAt
        FROM post_media
        ${where}
        UNION ALL
        SELECT id, post_id AS ownerId, 'group' AS source, url, type, taken_down AS takenDown, created_at AS createdAt
        FROM group_post_media
        ${where}
        ORDER BY createdAt DESC
        LIMIT ? OFFSET ?
        `,
        [Number(limit), Number(offset)]
      );
      res.json({ items: rows, page: Number(page), limit: Number(limit) });
    } catch (e) { next(e); }
  }
);

/** PUT /api/admin/media/:id/takedown { source:'post'|'group', down:boolean } */
router.put('/:id/takedown',
  [
    param('id').isString(),
    body('source').isIn(['post','group']),
    body('down').isBoolean()
  ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { source, down } = req.body;

      const table = source === 'post' ? 'post_media' : 'group_post_media';
      await pool.query(`UPDATE ${table} SET taken_down=? WHERE id=?`, [down ? 1 : 0, id]);

      await pool.query(
        `INSERT INTO admin_audit (admin_id, action, entity, entity_id, details)
         VALUES (?,?,?,?,JSON_OBJECT('source', ?, 'down', ?))`,
        [req.user.userId, 'media_takedown', table, String(id), source, !!down]
      );

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
