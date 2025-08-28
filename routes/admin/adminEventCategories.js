// routes/admin/adminEventCategories.js
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../../config/db');                 // mysql2 pool
const { ensureAuth,requireAdmin } = require('../../middlewares/auth');

const router = express.Router();

const vf = (res, errors) =>
  res.status(400).json({ errors: errors.array ? errors.array() : errors });

/**
 * Schema (from SQL):
 * - category_parent_id: NOT NULL, 0 means top-level
 * - category_description: NOT NULL (can be empty string)
 * - category_order: default 1
 */

// GET list (search + pagination)
router.get(
  '/',
  ensureAuth, requireAdmin,
  [
    query('search').optional().isString().trim(),
    query('page').optional().toInt(),
    query('limit').optional().toInt(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return vf(res, errors);

      const { search = '', page = 1, limit = 25 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);

      const where = [];
      const args = [];
      if (search) {
        where.push('(ec.category_name LIKE ? OR ec.category_description LIKE ?)');
        args.push(`%${search}%`, `%${search}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // total
      const [[cnt]] = await pool.query(
        `SELECT COUNT(*) AS total
           FROM events_categories ec
           ${whereSql}`,
        args
      );
      const total = Number(cnt.total) || 0;
      const totalPages = Math.max(1, Math.ceil(total / Number(limit)));

      // page rows + parent name + usage counts
      const [rows] = await pool.query(
        `
        SELECT
          ec.category_id        AS id,
          ec.category_parent_id AS parentId,
          ec.category_name      AS name,
          ec.category_description AS description,
          ec.category_order     AS \`order\`,
          CASE WHEN ec.category_parent_id = 0 THEN NULL
               ELSE p.category_name END       AS parentName,
          (SELECT COUNT(*) FROM events_categories c2 WHERE c2.category_parent_id = ec.category_id) AS childCount,
          (SELECT COUNT(*) FROM events e WHERE e.event_category = ec.category_id) AS usedCount
        FROM events_categories ec
        LEFT JOIN events_categories p ON p.category_id = ec.category_parent_id
        ${whereSql}
        ORDER BY ec.category_parent_id ASC, ec.category_order ASC, ec.category_name ASC
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

// Compact list for selects
router.get('/select', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         category_id        AS id,
         category_parent_id AS parentId,
         category_name      AS name,
         category_order     AS sort
       FROM events_categories
       ORDER BY category_parent_id ASC, category_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET one
router.get('/:id', ensureAuth, requireAdmin, [param('id').isInt({min:1})], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return vf(res, errors);

    const id = Number(req.params.id);
    const [[row]] = await pool.query(
      `SELECT
         category_id        AS id,
         category_parent_id AS parentId,
         category_name      AS name,
         category_description AS description,
         category_order     AS \`order\`
       FROM events_categories
       WHERE category_id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { next(e); }
});

// CREATE
router.post(
  '/',
  ensureAuth, requireAdmin,
  [
    body('name').isString().trim().isLength({ min: 1 }),
    body('parentId').optional().toInt().isInt({ min: 0 }),
    body('description').optional().isString(),  // NOT NULL in DB; allow '' client-side
    body('order').optional().toInt().isInt({ min: 1 }).optional({ nullable: true }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return vf(res, errors);

      const name = String(req.body.name).trim();
      const parentId = Number.isFinite(req.body.parentId) ? Number(req.body.parentId) : 0; // 0 = root
      const description = typeof req.body.description === 'string' ? req.body.description : '';
      const order = Number.isFinite(req.body.order) && Number(req.body.order) >= 1 ? Number(req.body.order) : 1;

      if (parentId !== 0) {
        const [[p]] = await pool.query(
          `SELECT category_id FROM events_categories WHERE category_id = ? LIMIT 1`,
          [parentId]
        );
        if (!p) return res.status(400).json({ error: 'Parent category not found' });
      }

      const [r] = await pool.query(
        `INSERT INTO events_categories
           (category_parent_id, category_name, category_description, category_order)
         VALUES (?, ?, ?, ?)`,
        [parentId, name, description, order]
      );
      res.status(201).json({ id: r.insertId });
    } catch (e) { next(e); }
  }
);

// UPDATE
router.put(
  '/:id',
  ensureAuth, requireAdmin,
  [
    param('id').isInt({min:1}),
    body('name').isString().trim().isLength({ min: 1 }),
    body('parentId').optional().toInt().isInt({ min: 0 }),
    body('description').optional().isString(),
    body('order').optional().toInt().isInt({ min: 1 }).optional({ nullable: true }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return vf(res, errors);

      const id = Number(req.params.id);
      const name = String(req.body.name).trim();
      const parentId = Number.isFinite(req.body.parentId) ? Number(req.body.parentId) : 0;
      const description = typeof req.body.description === 'string' ? req.body.description : '';
      const order = Number.isFinite(req.body.order) && Number(req.body.order) >= 1 ? Number(req.body.order) : 1;

      if (parentId === id) return res.status(400).json({ error: 'Category cannot be its own parent' });
      if (parentId !== 0) {
        const [[p]] = await pool.query(
          `SELECT category_id FROM events_categories WHERE category_id = ? LIMIT 1`,
          [parentId]
        );
        if (!p) return res.status(400).json({ error: 'Parent category not found' });
      }

      await pool.query(
        `UPDATE events_categories
            SET category_parent_id = ?,
                category_name = ?,
                category_description = ?,
                category_order = ?
          WHERE category_id = ?`,
        [parentId, name, description, order, id]
      );

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

// DELETE (guard if used/has children)
router.delete('/:id', ensureAuth, requireAdmin, [param('id').isInt({min:1})], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return vf(res, errors);

    const id = Number(req.params.id);

    const [[child]] = await pool.query(
      `SELECT COUNT(*) AS c FROM events_categories WHERE category_parent_id = ?`, [id]
    );
    if (child.c > 0) return res.status(400).json({ error: 'Remove/move child categories first' });

    const [[used]] = await pool.query(
      `SELECT COUNT(*) AS c FROM events WHERE event_category = ?`, [id]
    );
    if (used.c > 0) return res.status(400).json({ error: 'Category is used by events' });

    const [r] = await pool.query(`DELETE FROM events_categories WHERE category_id = ?`, [id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
