// routes/notifications.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');

/** Map legacy actions to your app's notification type tokens used in UI */
function mapActionToType(action) {
  switch (action) {
    case 'post_like':       // if legacy writes this already, keep it
    case 'like':            return 'post_like';
    case 'post_comment':
    case 'comment':         return 'post_comment';
    case 'friend_add':      return 'friend_request';
    case 'friend_accept':   return 'friend_accept';
    case 'follow':          return 'follow';
    case 'chat_message':    return 'message';
    case 'reel_like':       return 'reel_like';
    case 'reel_comment':    return 'reel_comment';
    case 'group_post':      return 'group_post';
    default:                return action || 'notify';
  }
}

/** Build an app link from legacy node_type/node_url/notify_id */
function inferLink(row) {
  const nodeType = (row.node_type || '').toLowerCase();
  const url = row.node_url || '';
  const id = row.notify_id;

  if (nodeType.includes('post')) {
    // prefer id if numeric; else fallback to url slug
    return id ? `/posts/${id}` : (url.startsWith('/') ? url : `/${url}`);
  }
  if (nodeType.includes('group')) {
    return id ? `/groups/${id}` : (url.startsWith('/') ? url : `/${url}`);
  }
  if (nodeType.includes('user') || nodeType === '' /* many rows empty */) {
    return `/profile/${row.from_user_id}`;
  }
  // generic fallback
  return url ? (url.startsWith('/') ? url : `/${url}`) : '#';
}

/** Shape row -> NotificationItem expected by frontend */
function mapRow(row) {
  return {
    // your React context uses "id", "type", "actor*", "createdAt", "readAt", "seenAt", "meta"
    id: Number(row.notification_id),
    type: mapActionToType(row.action),
    actorId: String(row.from_user_id),
    actorName: row.actor_name || `User ${row.from_user_id}`,
    actorAvatar: row.actor_avatar || null,
    createdAt: row.time ? new Date(row.time).toISOString() : new Date().toISOString(),
    // There is no read_at/seen_at column; we treat seen='1' as "read"
    readAt: row.seen === '1' ? new Date().toISOString() : null,
    seenAt: row.seen === '1' ? new Date().toISOString() : null,
    message: row.message || null,
    entityType: row.node_type || null,
    entityId: row.notify_id || null,
    href: inferLink(row),
    meta: {
      postId: row.node_type && row.node_type.toLowerCase().includes('post') ? row.notify_id : undefined,
      groupId: row.node_type && row.node_type.toLowerCase().includes('group') ? row.notify_id : undefined,
    },
  };
}

// GET /api/notifications?cursor=0&limit=20
router.get('/', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cursor = Math.max(0, parseInt(req.query.cursor ?? '0', 10));
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)));

    const [rows] = await pool.query(
      `
      SELECT n.notification_id, n.to_user_id, n.from_user_id, n.from_user_type,
             n.action, n.node_type, n.node_url, n.notify_id, n.message, n.time, n.seen,
             u.user_name AS actor_name, u.user_picture AS actor_avatar
        FROM notifications n
        JOIN users u ON u.user_id = n.from_user_id
       WHERE n.to_user_id = ?
       ORDER BY n.time DESC, n.notification_id DESC
       LIMIT ? OFFSET ?
      `,
      [userId, limit, cursor]
    );

    res.json(rows.map(mapRow));
  } catch (err) {
    console.error('[GET /notifications]', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE to_user_id=? AND seen='0'`,
      [userId]
    );
    res.json({ count: Number(row.count) || 0 });
  } catch (err) {
    console.error('[GET /notifications/unread-count]', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// POST /api/notifications/mark-read { ids: number[] }
router.post('/mark-read', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.json({ updated: 0 });

    const [r] = await pool.query(
      `UPDATE notifications SET seen='1'
        WHERE to_user_id=? AND notification_id IN (?) AND seen='0'`,
      [userId, ids]
    );
    res.json({ updated: r.affectedRows || 0 });
  } catch (err) {
    console.error('[POST /notifications/mark-read]', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// POST /api/notifications/mark-all-read
router.post('/mark-all-read', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [r] = await pool.query(
      `UPDATE notifications SET seen='1' WHERE to_user_id=? AND seen='0'`,
      [userId]
    );
    res.json({ updated: r.affectedRows || 0 });
  } catch (err) {
    console.error('[POST /notifications/mark-all-read]', err);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

// POST /api/notifications/mark-seen  (alias to mark all unseen as seen)
router.post('/mark-seen', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [r] = await pool.query(
      `UPDATE notifications SET seen='1' WHERE to_user_id=? AND seen='0'`,
      [userId]
    );
    res.json({ updated: r.affectedRows || 0 });
  } catch (err) {
    console.error('[POST /notifications/mark-seen]', err);
    res.status(500).json({ error: 'Failed to mark seen' });
  }
});

module.exports = router;
