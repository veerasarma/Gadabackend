// routes/admin/adminEvents.js
const express = require('express');
const router = express.Router();
const pool = require('../../config/db');            // your mysql2 pool
const { ensureAuth } = require('../../middlewares/auth');

// Minimal admin guard (same as other admin modules)
function requireAdmin(req, res, next) {
  const role = String(req.user?.roles || 'user').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* --------------------------------------------
 * Helpers
 * ------------------------------------------*/
function toMySQLDateTime(v) {
  // Accepts ISO-like strings or Date objects; returns "YYYY-MM-DD HH:MM:SS" or null
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* --------------------------------------------
 * LIST (search + pagination + aggregates)
 * GET /api/admin/events?search=&page=1&limit=20
 * ------------------------------------------*/
router.get('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(5, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const where = [];
    const args  = [];

    if (search) {
      where.push('(e.event_title LIKE ? OR u.user_name LIKE ? OR CONCAT_WS(" ", u.user_firstname, u.user_lastname) LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // total rows
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM events e
         JOIN users u ON u.user_id = e.event_admin
         ${whereSql}`,
      args
    );
    const total = Number(countRow.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    // page items with aggregates from events_members
    const [rows] = await pool.query(
      `
      SELECT
        e.event_id AS id,
        e.event_title AS title,
        e.event_privacy AS privacy,
        e.event_start_date AS startsAt,
        e.event_end_date   AS endsAt,
        e.event_location         AS location,     /* optional if you have this field */
        u.user_id          AS adminId,
        IFNULL(NULLIF(TRIM(CONCAT_WS(' ', u.user_firstname, u.user_lastname)), ''), u.user_name) AS adminName,
        u.user_picture     AS adminAvatar,

        COALESCE(SUM(m.is_interested), 0) AS interestedCount,
        COALESCE(SUM(m.is_going), 0)      AS goingCount,
        COALESCE(SUM(m.is_invited), 0)    AS invitedCount

      FROM events e
      JOIN users u ON u.user_id = e.event_admin
      LEFT JOIN events_members m ON m.event_id = e.event_id
      ${whereSql}
      GROUP BY e.event_id
      ORDER BY e.event_start_date DESC, e.event_id DESC
      LIMIT ? OFFSET ?
      `,
      [...args, limit, offset]
    );

    res.json({
      items: rows,
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages
    });
  } catch (e) { next(e); }
});

router.get('/categories', ensureAuth, requireAdmin, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           category_id       AS id,
           category_parent_id AS parentId,
           category_name     AS name,
           category_order    AS sort
         FROM events_categories
         ORDER BY category_parent_id ASC, category_order ASC, category_name ASC`
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

/* --------------------------------------------
 * GET one
 * ------------------------------------------*/
router.get('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = (req.params.id);
    console.log(id,'idid')
    const [[row]] = await pool.query(
      `
      SELECT
        e.event_id AS id,
        e.event_admin  AS adminId,
        e.event_category AS category_id,
        e.event_title AS title,
        e.event_description AS description,
        e.event_privacy AS privacy,
        e.event_start_date AS startsAt,
        e.event_end_date   AS endsAt,
        e.event_location,
        e.event_cover            AS cover
      FROM events e
      WHERE e.event_id = ?
      `,
      id
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { next(e); }
});

/* --------------------------------------------
 * CREATE
 * ------------------------------------------*/
router.post('/', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const adminId     = Number(req.body?.adminId) || Number(req.user.userId); // creator
    const title       = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const privacy     = String(req.body?.privacy || 'public');
    const startsAt    = toMySQLDateTime(req.body?.startsAt);
    const endsAt      = toMySQLDateTime(req.body?.endsAt);
    const location    = String(req.body?.location || '');
    const categoryId  = Number(req.body?.categoryId || 0) || null;
    const cover       = String(req.body?.cover || ''); // path, if you store

    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!startsAt) return res.status(400).json({ error: 'Start date/time is required' });

    const [r] = await pool.query(
      `INSERT INTO events
         (event_admin, event_category, event_title, event_description, event_privacy, event_start_date, event_end_date, event_location, event_cover)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, categoryId, title, description, privacy, startsAt, endsAt, location, cover || null]
    );

    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

/* --------------------------------------------
 * UPDATE
 * ------------------------------------------*/
router.put('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
  try {
    const id          = Number(req.params.id);
    const title       = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const privacy     = String(req.body?.privacy || 'public');
    const startsAt    = toMySQLDateTime(req.body?.startsAt);
    const endsAt      = toMySQLDateTime(req.body?.endsAt);
    const location    = String(req.body?.location || '');
    const categoryId  = Number(req.body?.categoryId || 0) || null;
    const cover       = String(req.body?.cover || '');

    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!startsAt) return res.status(400).json({ error: 'Start date/time is required' });

    const [r] = await pool.query(
      `UPDATE events
          SET event_category = ?,
              event_title = ?,
              event_description = ?,
              event_privacy = ?,
              event_start_date = ?,
              event_end_date   = ?,
              event_location = ?,
              event_cover = ?
        WHERE event_id = ?`,
      [categoryId, title, description, privacy, startsAt, endsAt, location, cover || null, id]
    );

    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* --------------------------------------------
 * DELETE (hard delete)
 * ------------------------------------------*/
router.delete('/:id', ensureAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
  
      // Get a dedicated connection for the transaction
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
  
        await conn.query(`DELETE FROM events_members WHERE event_id = ?`, [id]);
        const [r] = await conn.query(`DELETE FROM events WHERE event_id = ?`, [id]);
  
        await conn.commit();
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
      } catch (err) {
        await conn.rollback();
        next(err);
      } finally {
        conn.release();
      }
    } catch (e) {
      next(e);
    }
  });
  



  
module.exports = router;
