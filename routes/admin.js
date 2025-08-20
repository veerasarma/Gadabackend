const express = require('express');
const { query, body, param, validationResult } = require('express-validator');
const  db  = require('../config/db'); // adjust to your pool path
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
router.use(ensureAuth, requireRole('admin'));

// List users (search + cursor pagination)
router.get(
  '/users',
  [
    query('page').optional().toInt().isInt({ min: 1 }),
    query('limit').optional().toInt().isInt({ min: 1, max: 100 }),
    query('search').optional().isString().trim().isLength({ max: 100 }),
    query('sort').optional().isIn(['createdAt', 'username', 'email']),
    query('dir').optional().isIn(['asc', 'desc']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const page  = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 20);
      const search = (req.query.search || '').trim();
      const sort = req.query.sort || 'createdAt';
      const dir  = (req.query.dir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const offset = (page - 1) * limit;

      // Build WHERE
      const where = [];
      const params = [];
      if (search) {
        where.push('(u.user_name LIKE ? OR u.user_email LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // Count
      const [[countRow]] = await db.query(
        `SELECT COUNT(*) AS total
           FROM users u
           ${whereSql}`,
        params
      );
      const total = Number(countRow.total) || 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      // Sort map
      const sortMap = {
        createdAt: 'u.user_registered',
        username: 'u.user_name',
        email: 'u.user_email',
      };

      // Page
      const [rows] = await db.query(
        `
        SELECT
          u.user_id            AS id,
          u.user_name          AS username,
          u.user_email              AS email,
          u.user_registered         AS createdAt,
          u.user_group               AS role,
          u.user_banned       AS isSuspended
        FROM users u
        ${whereSql}
        ORDER BY ${sortMap[sort]} ${dir}
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      res.json({
        items: rows,
        page,
        limit,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/users/export
 * Query: format=csv|json, search=..., sort=..., dir=...
 * Streams CSV or returns JSON array
 */
router.get(
  '/users/export',
  [
    query('format').optional().isIn(['csv', 'json']),
    query('search').optional().isString().trim().isLength({ max: 100 }),
    query('sort').optional().isIn(['createdAt', 'username', 'email']),
    query('dir').optional().isIn(['asc', 'desc']),
  ],
  async (req, res, next) => {
    try {
      const format = (req.query.format || 'csv').toLowerCase();
      const search = (req.query.search || '').trim();
      const sort = req.query.sort || 'createdAt';
      const dir  = (req.query.dir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      const where = [];
      const params = [];
      if (search) {
        where.push('(u.user_name LIKE ? OR u.user_email LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const sortMap = {
        createdAt: 'u.createdAt',
        username: 'u.user_name',
        email: 'u.user_email',
      };

      const [rows] = await db.query(
        `
        SELECT
          u.user_id      AS id,
          u.user_name    AS username,
          u.user_email        AS email,
          u.createdAt   AS createdAt,
          u.role         AS role,
          u.is_suspended AS isSuspended
        FROM users u
        ${whereSql}
        ORDER BY ${sortMap[sort]} ${dir}
        `,
        params
      );

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json(rows);
      }

      // CSV
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="users_export.csv"');

      // Simple CSV writer (no external deps)
      const header = ['id', 'username', 'email', 'createdAt', 'role', 'isSuspended'];
      res.write(header.join(',') + '\n');
      for (const r of rows) {
        const line = [
          r.id,
          csvEscape(r.username),
          csvEscape(r.email),
          r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
          csvEscape(r.role || ''),
          r.isSuspended ? '1' : '0',
        ].join(',');
        res.write(line + '\n');
      }
      res.end();

      function csvEscape(val) {
        if (val == null) return '';
        const s = String(val);
        if (/[",\n]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }
    } catch (err) {
      next(err);
    }
  }
);



// Change role
router.patch('/users/:id/role',
  [ param('id').isInt(), body('role').isIn(['user','moderator','admin']) ],
  async (req, res) => {
    const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params; const { role } = req.body;

    // Variant 1 (ENUM):
    // await pool.query(`UPDATE users SET role=? WHERE user_id=?`, [role, id]);

    // Variant 2 (roles table):
    const [[roleRow]] = await db.query(`SELECT role_id FROM roles WHERE name=?`, [role]);
    if (!roleRow) return res.status(400).json({ error: 'Invalid role' });
    await db.query(`DELETE FROM user_roles WHERE user_id=?`, [id]);
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES (?,?)`, [id, roleRow.role_id]);

    res.json({ ok: true });
  }
);

// Suspend/unsuspend
router.patch('/users/:id/suspend',
  [ param('id').isInt(), body('suspended').isBoolean() ],
  async (req, res) => {
    const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params; const { suspended } = req.body;
    await db.query(`UPDATE users SET is_suspended=? WHERE user_id=?`, [suspended ? 1 : 0, id]);
    res.json({ ok: true });
  }
);

// Basic stats
router.get('/stats', async (_req, res) => {
  const [[u]] = await db.query(`SELECT COUNT(*) AS users FROM users`);
  const [[p]] = await db.query(`SELECT COUNT(*) AS posts FROM posts`);
  res.json({ users: u.users, posts: p.posts });
});

module.exports = router;
