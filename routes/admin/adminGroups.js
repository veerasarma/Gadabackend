// routes/adminGroups.js
const express = require('express');
const router = express.Router();
const pool = require('../../config/db');            // <- your mysql2 pool
const { ensureAuth, requireAdmin } = require('../../middlewares/auth');

// ------- METRICS (top stat cards) -------
router.get('/metrics', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const [[g]] = await pool.query(`SELECT COUNT(*) AS totalGroups FROM groups`);
    const [[pub]] = await pool.query(
      `SELECT COUNT(*) AS c FROM groups WHERE LOWER(COALESCE(group_privacy,''))='public'`
    );
    const [[closed]] = await pool.query(
      `SELECT COUNT(*) AS c FROM groups WHERE LOWER(COALESCE(group_privacy,''))='closed'`
    );
    const [[secret]] = await pool.query(
      `SELECT COUNT(*) AS c FROM groups WHERE LOWER(COALESCE(group_privacy,''))='secret'`
    );
    const [[mem]] = await pool.query(`SELECT COUNT(*) AS totalMembers FROM groups_members`);

    res.json({
      totalGroups: Number(g?.totalGroups || 0),
      publicGroups: Number(pub?.c || 0),
      closedGroups: Number(closed?.c || 0),
      secretGroups: Number(secret?.c || 0),
      totalMembers: Number(mem?.totalMembers || 0),
    });
  } catch (e) { next(e); }
});

// ------- LIST / SEARCH / PAGINATION -------
router.get('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const { search = '', privacy = 'all', page = 1, limit = 10 } = req.query;
    const lim = Math.min(100, Math.max(1, Number(limit)));
    const off = (Math.max(1, Number(page)) - 1) * lim;

    const where = [];
    const args = [];

    if (search) {
      where.push(`(
        g.group_title LIKE ?
        OR g.group_name LIKE ?
      )`);
      args.push(`%${search}%`, `%${search}%`);
    }

    if (privacy && privacy !== 'all') {
      where.push(`LOWER(COALESCE(g.group_privacy,'')) = ?`);
      args.push(String(privacy).toLowerCase());
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // total
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM groups g ${whereSql}`,
      args
    );
    const total = Number(countRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / lim));

    // list
    const [rows] = await pool.query(
      `
      SELECT
        g.group_id                                   AS id,
        COALESCE(NULLIF(TRIM(g.group_title), ''), g.group_name, CONCAT('Group #', g.group_id)) AS title,
        COALESCE(g.group_privacy, 'public')          AS privacy,
        g.group_name                                  AS slug,
        /* one admin (any) via compact subselect to avoid duplicates */
        (SELECT u.user_name
           FROM groups_admins ga
           JOIN users u ON u.user_id = ga.user_id
          WHERE ga.group_id = g.group_id
          ORDER BY ga.user_id ASC
          LIMIT 1)                                   AS adminUsername,
        /* members by counting rows */
        (SELECT COUNT(*) FROM groups_members gm WHERE gm.group_id = g.group_id) AS membersCount,
        g.group_date                              AS createdAt
      FROM groups g
      ${whereSql}
      ORDER BY g.group_date DESC
      LIMIT ? OFFSET ?
      `,
      [...args, lim, off]
    );

    res.json({
      items: rows,
      page: Number(page),
      limit: lim,
      total,
      totalPages,
      hasPrev: Number(page) > 1,
      hasNext: Number(page) < totalPages,
    });
  } catch (e) { next(e); }
});

// ------- HARD DELETE (and clean children) -------
router.delete('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    await conn.beginTransaction();

    await conn.query(`DELETE FROM groups_invites  WHERE group_id = ?`, [id]);
    await conn.query(`DELETE FROM groups_members  WHERE group_id = ?`, [id]);
    await conn.query(`DELETE FROM groups_admins   WHERE group_id = ?`, [id]);
    await conn.query(`DELETE FROM groups          WHERE group_id = ?`, [id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
});

module.exports = router;
