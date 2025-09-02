const express = require('express');
const { query, body, param, validationResult } = require('express-validator');
const  db  = require('../config/db'); // adjust to your db path
const { ensureAuth, requireRole,requireAdmin } = require('../middlewares/auth');

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
          u.user_banned       AS user_banned
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
    // await db.query(`UPDATE users SET role=? WHERE user_id=?`, [role, id]);

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
// router.get('/stats', async (_req, res) => {
//   const [[u]] = await db.query(`SELECT COUNT(*) AS users FROM users`);
//   const [[p]] = await db.query(`SELECT COUNT(*) AS posts FROM posts`);
//   res.json({ users: u.users, posts: p.posts });
// });

// ---- Table/column map (edit here to fit your schema) ----
const T = {
  users: {
    table: "users",
    dateCol: "user_registered",
    isUnix: true,
    cols: {
      banned: "user_banned",
      activated: "user_activated",
      status: "user_approved",
      lastseen: "user_last_seen",
      onlineFlag: "user_is_online",
    },
  },
  posts:        { table: "posts",                   dateCol: "time",            isUnix: true },
  pages:        { table: "pages",                   dateCol: "page_date",       isUnix: true },
  groups:       { table: "groups",                  dateCol: "group_date",      isUnix: true },
  events:       { table: "events",                  dateCol: "event_date",      isUnix: true },
  comments:     { table: "posts_comments",          dateCol: "time",            isUnix: true },
  messages:     { table: "conversations_messages",  dateCol: "time",            isUnix: true },
  notifications:{ table: "notifications",           dateCol: "time",            isUnix: true },

  // Optional: if you track site visits, fill these and set isUnix accordingly.
  // visits: { table: "site_visits", dateCol: "time", isUnix: true },
};

// --- helpers ---
const dateExpr = (col, isUnix) => (isUnix ? `FROM_UNIXTIME(${col})` : col);

async function countSafe(sql, params = []) {
  try {
    const [rows] = await db.query(sql, params);
    const v = rows?.[0] && (rows[0].c ?? rows[0].count ?? Object.values(rows[0])[0]);
    return Number(v || 0);
  } catch (e) {
    console.error("countSafe error:", e);
    return 0;
  }
}

async function monthlyCount({ table, dateCol, isUnix }, year) {
  const d = dateExpr(dateCol, isUnix);
  try {
    const [rows] = await db.query(
      `SELECT MONTH(${d}) AS m, COUNT(*) AS c
         FROM ${table}
        WHERE YEAR(${d}) = ?
        GROUP BY MONTH(${d})`,
      [year]
    );
    const arr = Array(12).fill(0);
    for (const r of rows) arr[(Number(r.m) || 1) - 1] = Number(r.c || 0);
    return arr;
  } catch (e) {
    console.error("monthlyCount error:", table, e);
    return Array(12).fill(0);
  }
}

// ----------------- KPI endpoint -----------------
router.get("/stats", ensureAuth, requireAdmin, async (_req, res) => {
  try {
    // Users
    const U = T.users;

    const totalUsers = await countSafe(`SELECT COUNT(*) AS c FROM ${U.table}`);

    // user_is_online = 1 (preferred)
    let online = 0;
    // let online = await countSafe(
    //   `SELECT COUNT(*) AS c FROM ${U.table} WHERE ${U.cols.onlineFlag} = 1`
    // );
    // fallback: last seen within 5 minutes
    if (online === 0) {
      const lastSeenExpr = dateExpr(U.cols.lastseen, true);
      online = await countSafe(
        `SELECT COUNT(*) AS c
           FROM ${U.table}
          WHERE ${U.cols.lastseen} IS NOT NULL
            AND TIMESTAMPDIFF(MINUTE, ${lastSeenExpr}, NOW()) <= 5`
      );
    }

    // pending = not approved
    const pendingUsers = await countSafe(
      `SELECT COUNT(*) AS c FROM ${U.table} WHERE ${U.cols.status} = 0`
    );

    // not activated
    const notActivated = await countSafe(
      `SELECT COUNT(*) AS c FROM ${U.table} WHERE ${U.cols.activated} = 0`
    );

    // banned
    const banned = await countSafe(
      `SELECT COUNT(*) AS c FROM ${U.table} WHERE ${U.cols.banned} = 1`
    );

    // Content counts
    const posts   = await countSafe(`SELECT COUNT(*) AS c FROM ${T.posts.table}`);
    const comments= await countSafe(`SELECT COUNT(*) AS c FROM ${T.comments.table}`);
    const pages   = await countSafe(`SELECT COUNT(*) AS c FROM ${T.pages.table}`);
    const groups  = await countSafe(`SELECT COUNT(*) AS c FROM ${T.groups.table}`);
    const events  = await countSafe(`SELECT COUNT(*) AS c FROM ${T.events.table}`);
    const messages= await countSafe(`SELECT COUNT(*) AS c FROM ${T.messages.table}`);
    const notifs  = await countSafe(`SELECT COUNT(*) AS c FROM ${T.notifications.table}`);

    // Visits (optional; return zeros if you don't track)
    let totalVisits = 0, todayVisits = 0, monthVisits = 0;
    if (T.visits) {
      const V = T.visits;
      const d = dateExpr(V.dateCol, !!V.isUnix);
      totalVisits = await countSafe(`SELECT COUNT(*) AS c FROM ${V.table}`);
      todayVisits = await countSafe(`SELECT COUNT(*) AS c FROM ${V.table} WHERE DATE(${d}) = CURDATE()`);
      monthVisits = await countSafe(
        `SELECT COUNT(*) AS c
           FROM ${V.table}
          WHERE YEAR(${d}) = YEAR(CURDATE())
            AND MONTH(${d}) = MONTH(CURDATE())`
      );
    }

    res.json({
      totalUsers, online, pendingUsers, notActivated, banned,
      totalVisits, todayVisits, monthVisits,
      posts, comments, pages, groups, events, messages, notifications: notifs,
    });
  } catch (e) {
    console.error("GET /api/admin/stats error:", e);
    res.status(500).json({ error: "Failed to load admin stats" });
  }
});

// -------------- Monthly chart endpoint --------------
router.get("/stats/monthly", ensureAuth, requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year || new Date().getFullYear());
    const data = {
      year,
      users:  await monthlyCount(T.users,  year),
      pages:  await monthlyCount(T.pages,  year),
      groups: await monthlyCount(T.groups, year),
      events: await monthlyCount(T.events, year),
      posts:  await monthlyCount(T.posts,  year),
    };
    res.json(data);
  } catch (e) {
    console.error("GET /api/admin/stats/monthly error:", e);
    res.status(500).json({ error: "Failed to load monthly chart data" });
  }
});

module.exports = router;
