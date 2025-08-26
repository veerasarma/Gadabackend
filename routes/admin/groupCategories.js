// routes/admin/groupCategories.js
const express = require('express');
const router = express.Router();
const pool = require('../../config/db');                 // your mysql2 pool
const { ensureAuth } = require('../../middlewares/auth');

// Simple admin guard (same pattern you already use)
function requireAdmin(req, res, next) {
  const role = String(req.user?.roles || 'user').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* ---------- LIST (table) ---------- */
router.get('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const where = [];
    const args  = [];
    if (search) {
      where.push('(category_name LIKE ? OR category_description LIKE ?)');
      args.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `
      SELECT category_id, category_parent_id, category_name, category_description, category_order
      FROM groups_categories
      ${whereSql}
      ORDER BY category_order ASC, category_name ASC
      `,
      args
    );

    res.json(rows.map(r => ({
      id: r.category_id,
      parentId: r.category_parent_id,
      name: r.category_name,
      description: r.category_description,
      order: r.category_order
    })));
  } catch (e) { next(e); }
});

/* ---------- PARENT OPTIONS (for select) ---------- */
router.get('/options', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT category_id, category_name FROM groups_categories ORDER BY category_name ASC`
    );
    res.json(rows.map(r => ({ id: r.category_id, name: r.category_name })));
  } catch (e) { next(e); }
});

/* ---------- GET one (edit) ---------- */
router.get('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [[row]] = await pool.query(
      `SELECT category_id, category_parent_id, category_name, category_description, category_order
         FROM groups_categories WHERE category_id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: row.category_id,
      parentId: row.category_parent_id,
      name: row.category_name,
      description: row.category_description,
      order: row.category_order
    });
  } catch (e) { next(e); }
});

/* ---------- CREATE ---------- */
router.post('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '');
    const parentId = Number(req.body?.parentId || 0);
    const order = Number.isFinite(Number(req.body?.order)) ? Number(req.body.order) : 0;

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (parentId < 0) return res.status(400).json({ error: 'Bad parent' });

    const [r] = await pool.query(
      `INSERT INTO groups_categories
         (category_parent_id, category_name, category_description, category_order)
       VALUES (?, ?, ?, ?)`,
      [parentId, name, description, order]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

/* ---------- UPDATE ---------- */
router.put('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '');
    const parentId = Number(req.body?.parentId || 0);
    const order = Number.isFinite(Number(req.body?.order)) ? Number(req.body.order) : 0;

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (parentId < 0) return res.status(400).json({ error: 'Bad parent' });

    const [r] = await pool.query(
      `UPDATE groups_categories
          SET category_parent_id = ?, category_name = ?, category_description = ?, category_order = ?
        WHERE category_id = ?`,
      [parentId, name, description, order, id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- DELETE (hard) ---------- */
router.delete('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Optional guard: ensure no groups are still using this category (if you keep a FK)
    // const [[c]] = await pool.query(`SELECT COUNT(*) AS cnt FROM groups WHERE category_id = ?`, [id]);
    // if (Number(c.cnt) > 0) return res.status(400).json({ error: 'Category in use' });

    const [r] = await pool.query(`DELETE FROM groups_categories WHERE category_id = ?`, [id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
