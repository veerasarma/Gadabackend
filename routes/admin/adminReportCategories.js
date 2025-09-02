// routes/adminReportCategories.js
const express = require('express');
const router = express.Router();

// Reuse your helpers/middlewares:
const { requireAdmin } = require('../../middlewares/auth');   // adjust path if different
const pool = require('../../config/db');                             // your mysql2 pool

// map DB row -> API shape
function mapRow(r) {
  return {
    id: r.category_id,
    parentId: r.category_parent_id,
    name: r.category_name,
    description: r.category_description,
    order: r.category_order,
  };
}

/**
 * GET /api/admin/report-categories
 * Optional ?search=term
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    let sql = `
      SELECT category_id, category_parent_id, category_name, category_description, category_order
      FROM reports_categories
    `;
    const params = [];
    if (search) {
      sql += ` WHERE category_name LIKE ? OR category_description LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ` ORDER BY category_order ASC, category_name ASC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows.map(mapRow));
  } catch (e) {
    console.error('[GET report-categories]', e);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

/**
 * GET /api/admin/report-categories/:id
 */
router.get('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      `SELECT category_id, category_parent_id, category_name, category_description, category_order
         FROM reports_categories
        WHERE category_id = ?
        LIMIT 1`,
      [id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(mapRow(row));
  } catch (e) {
    console.error('[GET report-categories/:id]', e);
    res.status(500).json({ error: 'Failed to fetch category' });
  }
});

/**
 * POST /api/admin/report-categories
 * body: { parentId, name, description, order }
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const parentId = Number(req.body.parentId || 0);
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '');
    const order = Number(req.body.order || 1);

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const [result] = await pool.query(
      `INSERT INTO reports_categories
         (category_parent_id, category_name, category_description, category_order)
       VALUES (?, ?, ?, ?)`,
      [parentId, name, description, order]
    );
    res.json({ id: result.insertId });
  } catch (e) {
    console.error('[POST report-categories]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

/**
 * PUT /api/admin/report-categories/:id
 * body: { parentId, name, description, order }
 */
router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const parentId = Number(req.body.parentId || 0);
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '');
    const order = Number(req.body.order || 1);

    if (!name) return res.status(400).json({ error: 'Name is required' });

    await pool.query(
      `UPDATE reports_categories
          SET category_parent_id = ?, category_name = ?, category_description = ?, category_order = ?
        WHERE category_id = ?`,
      [parentId, name, description, order, id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[PUT report-categories/:id]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

/**
 * DELETE /api/admin/report-categories/:id
 * If this category has children, re-parent them to 0 to avoid orphans.
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    // Re-parent children (optional, avoids FK issues later)
    await pool.query(
      `UPDATE reports_categories
          SET category_parent_id = 0
        WHERE category_parent_id = ?`,
      [id]
    );

    const [result] = await pool.query(
      `DELETE FROM reports_categories WHERE category_id = ?`,
      [id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE report-categories/:id]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
