// routes/admin/pages.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');

/** optional: keep your existing admin guard */
function requireAdmin(req, res, next) {
  const role = String(req.user?.roles || 'user').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* =========================
   METRICS (no is_deleted)
   ========================= */
router.get('/metrics', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM pages)                                        AS totalPages,
        (SELECT COUNT(*) FROM pages WHERE page_verified = '1')              AS verifiedPages,
        (SELECT COALESCE(SUM(page_likes),0) FROM pages)                     AS totalLikes
    `);
    const r = rows[0] || {};
    res.json({
      totalPages: Number(r.totalPages || 0),
      verifiedPages: Number(r.verifiedPages || 0),
      totalLikes: Number(r.totalLikes || 0),
    });
  } catch (e) { next(e); }
});

/* =========================
   LIST (filter + paginate)
   ========================= */
router.get('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');             // all|verified|unverified
    const search = String(req.query.search || '').trim();
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const where = [];
    const args  = [];

    if (status === 'verified') where.push(`p.page_verified = '1'`);
    if (status === 'unverified') where.push(`p.page_verified = '0'`);

    if (search) {
      where.push(`(p.page_title LIKE ? OR p.page_name LIKE ?)`);
      args.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // total
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM pages p ${whereSql}`,
      args
    );
    const total = Number(countRow.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    // rows
    const [rows] = await pool.query(
      `
      SELECT
        p.page_id       AS id,
        p.page_name     AS handle,
        p.page_title    AS title,
        p.page_picture  AS picture,
        p.page_cover    AS cover,
        p.page_likes    AS likes,
        p.page_verified AS verified,
        p.page_date          AS createdAt,
        (
          SELECT u.user_name
            FROM pages_admins pa
            JOIN users u ON u.user_id = pa.user_id
           WHERE pa.page_id = p.page_id
           LIMIT 1
        ) AS adminName
      FROM pages p
      ${whereSql}
      ORDER BY p.page_date DESC
      LIMIT ? OFFSET ?
      `,
      [...args, limit, offset]
    );

    res.json({
      items: rows.map(r => ({
        id: String(r.id),
        handle: r.handle,
        title: r.title,
        picture: r.picture,
        cover: r.cover,
        likes: Number(r.likes || 0),
        verified: String(r.verified) === '1',
        adminName: r.adminName || '',
        createdAt: r.createdAt
      })),
      page, limit, total, totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages
    });
  } catch (e) { next(e); }
});

/* =========================
   VERIFY / UNVERIFY
   ========================= */
router.patch('/:id/verify', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const verified = !!req.body?.verified;
    const [r] = await pool.query(
      `UPDATE pages SET page_verified = ? WHERE page_id = ?`,
      [verified ? '1' : '0', id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Page not found' });
    res.json({ ok: true, verified });
  } catch (e) { next(e); }
});

/* =========================
   HARD DELETE (no soft flag)
   ========================= */
router.delete('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });

    // If you do NOT have FK cascades, optionally delete dependents first inside a tx.
    // const conn = await pool.getConnection();
    // try {
    //   await conn.beginTransaction();
    //   await conn.query(`DELETE FROM pages_admins  WHERE page_id = ?`, [id]);
    //   await conn.query(`DELETE FROM pages_likes   WHERE page_id = ?`, [id]);
    //   await conn.query(`DELETE FROM pages_invites WHERE page_id = ?`, [id]);
    //   await conn.query(`DELETE FROM pages WHERE page_id = ?`, [id]);
    //   await conn.commit();
    //   return res.json({ ok: true, deleted: String(id) });
    // } catch (err) {
    //   await conn.rollback();
    //   throw err;
    // } finally {
    //   conn.release();
    // }

    // Simple hard delete (requires either no dependents or FK ON DELETE CASCADE)
    const [r] = await pool.query(`DELETE FROM pages WHERE page_id = ?`, [id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Page not found' });
    res.json({ ok: true, deleted: String(id) });
  } catch (e) { next(e); }
});

module.exports = router;
