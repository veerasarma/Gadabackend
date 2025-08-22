// routes/events.js
const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const router = express.Router();

const pool = require('../config/db');               // mysql2 pool (promise support)
const { ensureAuth } = require('../middlewares/auth');
const { uploadSingleImageToYearMonth } = require('../utils/upload'); // same helper used elsewhere

// Helpers
function mapEventRow(r) {
  return {
    id: String(r.event_id),
    adminId: String(r.event_admin),
    pageId: r.event_page_id ? String(r.event_page_id) : null,
    categoryId: r.event_category,
    title: r.event_title,
    location: r.event_location || '',
    countryId: r.event_country,
    description: r.event_description || '',
    startAt: r.event_start_date,
    endAt: r.event_end_date,
    privacy: r.event_privacy,
    cover: r.event_cover || null,
    ticketsLink: r.event_tickets_link || null,
    prices: r.event_prices || null,
    isSponsored: r.event_is_sponsored === '1',
    stats: {
      invited: Number(r.invited || 0),
      interested: Number(r.interested || 0),
      going: Number(r.going || 0),
    }
  };
}

// Recompute counters from events_members to stay consistent
async function recomputeCounters(conn, eventId) {
  const [[c]] = await conn.query(
    `SELECT
       SUM(is_invited='1')    AS invited,
       SUM(is_interested='1') AS interested,
       SUM(is_going='1')      AS going
     FROM events_members
     WHERE event_id = ?`,
    [eventId]
  );
  await conn.query(
    `UPDATE events
        SET event_invited   = ?,
            event_interested= ?,
            event_going     = ?
      WHERE event_id = ?`,
    [Number(c.invited||0), Number(c.interested||0), Number(c.going||0), eventId]
  );
}

//
// Categories
//
router.get('/categories', ensureAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT category_id, category_name, category_parent_id, category_order
         FROM events_categories
        ORDER BY category_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('[GET /events/categories]', e);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

//
// List (Discover / My / Filters)
//  - q: search in title
//  - categoryId
//  - when: 'upcoming' | 'past' | 'today' | 'week' | 'month'
//  - my: 'interested' | 'going' | 'admin' | 'invited'
//  - cursor: event_id for pagination (desc by created or asc by time for upcoming)
//  - limit
//
router.get('/',
  ensureAuth,
  [
    query('q').optional().isString(),
    query('categoryId').optional().toInt(),
    query('when').optional().isIn(['upcoming','past','today','week','month']),
    query('my').optional().isIn(['interested','going','admin','invited']),
    query('cursor').optional().toInt(),
    query('limit').optional().toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.userId;
    const q        = (req.query.q || '').trim().toLowerCase();
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const when     = req.query.when || 'upcoming';
    const my       = req.query.my || null;
    const limit    = Math.min(24, Math.max(6, Number(req.query.limit) || 12));
    const cursor   = req.query.cursor ? Number(req.query.cursor) : null;

    // Base visibility:
    // show public events, plus your own admin events, plus events where you're a member/invited
    const params = [];
    let where = `(e.event_privacy='public'
               OR e.event_admin = ?
               OR EXISTS(SELECT 1 FROM events_members em
                          WHERE em.event_id = e.event_id AND em.user_id = ?))`;
    params.push(userId, userId);

    if (q) { where += ` AND LOWER(e.event_title) LIKE ?`; params.push(`${q}%`); }
    if (categoryId) { where += ` AND e.event_category = ?`; params.push(categoryId); }

    // When window
    if (when === 'upcoming') {
      where += ` AND e.event_start_date >= NOW()`;
    } else if (when === 'past') {
      where += ` AND e.event_end_date < NOW()`;
    } else if (when === 'today') {
      where += ` AND DATE(e.event_start_date) = CURRENT_DATE()`;
    } else if (when === 'week') {
      where += ` AND e.event_start_date >= CURRENT_DATE()
                 AND e.event_start_date < (CURRENT_DATE() + INTERVAL 7 DAY)`;
    } else if (when === 'month') {
      where += ` AND e.event_start_date >= DATE_SUB(DATE_ADD(LAST_DAY(NOW()), INTERVAL 1 DAY), INTERVAL 1 MONTH)
                 AND e.event_start_date <  DATE_ADD(LAST_DAY(NOW()), INTERVAL 1 DAY)`;
    }

    // "My" filter
    if (my === 'admin') {
      where += ` AND e.event_admin = ?`; params.push(userId);
    } else if (my === 'interested') {
      where += ` AND EXISTS(SELECT 1 FROM events_members m
                             WHERE m.event_id=e.event_id AND m.user_id=? AND m.is_interested='1')`;
      params.push(userId);
    } else if (my === 'going') {
      where += ` AND EXISTS(SELECT 1 FROM events_members m
                             WHERE m.event_id=e.event_id AND m.user_id=? AND m.is_going='1')`;
      params.push(userId);
    } else if (my === 'invited') {
      where += ` AND EXISTS(SELECT 1 FROM events_members m
                             WHERE m.event_id=e.event_id AND m.user_id=? AND m.is_invited='1')`;
      params.push(userId);
    }

    // Pagination
    let orderBy = `e.event_start_date ASC`;
    if (when === 'past') orderBy = `e.event_start_date DESC`;
    if (cursor) {
      // use event_id cursor independent from sort; return items with id < cursor
      where += ` AND e.event_id < ?`;
      params.push(cursor);
      orderBy = `e.event_id DESC`;
    }

    try {
      const [rows] = await pool.query(
        `
        SELECT e.event_id, e.event_privacy, e.event_admin, e.event_page_id, e.event_category,
               e.event_title, e.event_location, e.event_country, e.event_description,
               e.event_start_date, e.event_end_date, e.event_cover, e.event_tickets_link, e.event_prices,
               e.event_invited AS invited, e.event_interested AS interested, e.event_going AS going
          FROM events e
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT ${limit}
        `,
        params
      );
      const items = rows.map(mapEventRow);
      const nextCursor = items.length === limit ? Number(items[items.length - 1].id) : null;
      res.json({ items, nextCursor });
    } catch (e) {
      console.error('[GET /events]', e);
      res.status(500).json({ error: 'Failed to load events' });
    }
  }
);
function isoToMySQLDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    // store in UTC to be consistent
    const Y = d.getUTCFullYear();
    const M = pad(d.getUTCMonth() + 1);
    const D = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const m = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    return `${Y}-${M}-${D} ${h}:${m}:${s}`;
  }

//
// Create event
//
router.post('/',
  ensureAuth,
  uploadSingleImageToYearMonth('cover', 'photos'), // optional cover file field named "cover"
  [
    body('title').isString().isLength({ min: 3, max: 256 }),
    body('description').isString().isLength({ min: 1 }),
    body('location').optional({ nullable: true }).isString(),
    body('countryId').isInt(),
    body('categoryId').isInt(),
    body('privacy').optional().isIn(['public','closed','secret']),
    body('startAt').isISO8601(),
    body('endAt').isISO8601(),
    body('ticketsLink').optional({ nullable: true }).isString(),
    body('prices').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const userId = req.user.userId;
    const {
      title, description, location, countryId, categoryId,
      privacy = 'public', startAt, endAt, ticketsLink = null, prices = null
    } = req.body;

    const startSql = isoToMySQLDateTime(startAt);
    const endSql   = isoToMySQLDateTime(endAt);
    if (!startSql || !endSql) {
      return res.status(400).json({ error: 'Invalid start/end datetime' });
    }

    const coverRelPath = req.file?.relativePath || null; // upload helper sets relativePath "photos/YYYY/MM/filename"

    try {
      const [r] = await pool.query(
        `INSERT INTO events
           (event_privacy, event_admin, event_page_id, event_category, event_title,
            event_location, event_country, event_description, event_start_date, event_end_date,
            event_cover, event_tickets_link, event_prices, event_date)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [privacy, userId, categoryId, title, location || null, countryId, description, startSql, endSql,
         coverRelPath, ticketsLink, prices]
      );
      const eventId = r.insertId;
      res.status(201).json({ id: String(eventId) });
    } catch (e) {
      console.error('[POST /events]', e);
      res.status(500).json({ error: 'Failed to create event' });
    }
  }
);

//
// Get event by id + my RSVP
//
router.get('/:id',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res) => {
    const eventId = Number(req.params.id);
    const userId = req.user.userId;
    try {
      const [[row]] = await pool.query(
        `SELECT e.*
           FROM events e
          WHERE e.event_id = ?`,
        [eventId]
      );
      if (!row) return res.status(404).json({ error: 'Not found' });

      const [[me]] = await pool.query(
        `SELECT is_invited, is_interested, is_going
           FROM events_members
          WHERE event_id=? AND user_id=? LIMIT 1`,
        [eventId, userId]
      );
      const my = {
        invited: me ? me.is_invited === '1' : false,
        interested: me ? me.is_interested === '1' : false,
        going: me ? me.is_going === '1' : false
      };

      // admins list (single admin id stored on event)
      const [[adminRow]] = await pool.query(
        `SELECT user_id AS id, 
                IFNULL(NULLIF(TRIM(CONCAT_WS(' ', user_firstname, user_lastname)), ''), user_name) AS fullName,
                user_name AS username,
                user_picture AS avatar
           FROM users WHERE user_id = ?`,
        [row.event_admin]
      );

      // Counters from events_members to be accurate
      const [[c]] = await pool.query(
        `SELECT
           SUM(is_invited='1')    AS invited,
           SUM(is_interested='1') AS interested,
           SUM(is_going='1')      AS going
         FROM events_members
         WHERE event_id = ?`,
        [eventId]
      );

      res.json({
        event: mapEventRow({ ...row, invited: c.invited||0, interested: c.interested||0, going: c.going||0 }),
        admins: adminRow ? [adminRow] : [],
        my
      });
    } catch (e) {
      console.error('[GET /events/:id]', e);
      res.status(500).json({ error: 'Failed to load event' });
    }
  }
);

//
// RSVP: interested / going / none
//
router.post('/:id/rsvp',
  ensureAuth,
  [
    param('id').isInt().toInt(),
    body('status').isIn(['interested','going','none'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const eventId = Number(req.params.id);
    const userId = req.user.userId;
    const status = req.body.status;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Upsert membership row
      const [[exists]] = await conn.query(
        `SELECT id FROM events_members WHERE event_id=? AND user_id=? LIMIT 1`,
        [eventId, userId]
      );

      let flags = { invited: '0', interested: '0', going: '0' };
      if (status === 'interested') flags.interested = '1';
      if (status === 'going') flags.going = '1';

      if (exists) {
        await conn.query(
          `UPDATE events_members
              SET is_invited='0', is_interested=?, is_going=?
            WHERE id=?`,
          [flags.interested, flags.going, exists.id]
        );
      } else {
        await conn.query(
          `INSERT INTO events_members
             (event_id, user_id, is_invited, is_interested, is_going)
           VALUES (?, ?, '0', ?, ?)`,
          [eventId, userId, flags.interested, flags.going]
        );
      }

      await recomputeCounters(conn, eventId);
      await conn.commit();

      res.json({ ok: true, status });
    } catch (e) {
      await conn.rollback();
      console.error('[POST /events/:id/rsvp]', e);
      res.status(500).json({ error: 'Failed to update RSVP' });
    } finally {
      conn.release();
    }
  }
);

//
// Members list (attendees)
//
router.get('/:id/members',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res) => {
    const eventId = Number(req.params.id);
    try {
      const [rows] = await pool.query(
        `SELECT m.user_id, m.is_invited, m.is_interested, m.is_going,
                u.user_name, u.user_firstname, u.user_lastname, u.user_picture
           FROM events_members m
           JOIN users u ON u.user_id = m.user_id
          WHERE m.event_id = ?
          ORDER BY m.is_going DESC, m.is_interested DESC`,
        [eventId]
      );
      const data = rows.map(r => ({
        id: String(r.user_id),
        username: r.user_name,
        fullName: [r.user_firstname, r.user_lastname].filter(Boolean).join(' ') || r.user_name,
        avatar: r.user_picture || null,
        invited: r.is_invited === '1',
        interested: r.is_interested === '1',
        going: r.is_going === '1'
      }));
      res.json(data);
    } catch (e) {
      console.error('[GET /events/:id/members]', e);
      res.status(500).json({ error: 'Failed to load members' });
    }
  }
);

//
// Invite users (admin only)
//
router.post('/:id/invite',
  ensureAuth,
  [ param('id').isInt().toInt(), body('userId').isInt().toInt() ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const eventId = Number(req.params.id);
    const toUserId = Number(req.body.userId);
    const fromUserId = req.user.userId;

    const conn = await pool.getConnection();
    try {
      const [[ev]] = await conn.query(`SELECT event_admin FROM events WHERE event_id=?`, [eventId]);
      if (!ev) { conn.release(); return res.status(404).json({ error: 'Not found' }); }
      if (Number(ev.event_admin) !== Number(fromUserId)) {
        conn.release(); return res.status(403).json({ error: 'Forbidden' });
      }

      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO events_members (event_id, user_id, is_invited, is_interested, is_going)
         VALUES (?, ?, '1', '0', '0')
         ON DUPLICATE KEY UPDATE is_invited='1'`,
        [eventId, toUserId]
      );
      await recomputeCounters(conn, eventId);
      await conn.commit();

      // optional: notify service call here
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      console.error('[POST /events/:id/invite]', e);
      res.status(500).json({ error: 'Failed to invite' });
    } finally {
      conn.release();
    }
  }
);

//
// My invites (list events where I'm invited)
//
router.get('/invites/me', ensureAuth, async (req, res) => {
  const userId = req.user.userId;
  try {
    const [rows] = await pool.query(
      `SELECT e.event_id, e.event_title, e.event_start_date, e.event_cover
         FROM events_members m
         JOIN events e ON e.event_id = m.event_id
        WHERE m.user_id = ? AND m.is_invited='1'
        ORDER BY e.event_start_date ASC
        LIMIT 100`,
      [userId]
    );
    res.json(rows.map(r => ({
      id: String(r.event_id),
      title: r.event_title,
      startAt: r.event_start_date,
      cover: r.event_cover || null
    })));
  } catch (e) {
    console.error('[GET /events/invites/me]', e);
    res.status(500).json({ error: 'Failed to load invites' });
  }
});

module.exports = router;
