// server/services/notify.js
const pool = require('../config/db');
const { getIO } = require('../socket');


async function createNotification({
  recipientId: recipientUserId,   // rename on destructure
  userId: actorUserId,   
  type,                 // 'post_like' | 'post_comment' | ...
  entityType,           // 'post' | 'reel' | 'group' | ...
  entityId,             // numeric id of entity
  message = null,
  meta = null,          // object (will be JSON.stringified)            // optional socket.io server (to push live)
}) {
  if (!recipientUserId || !actorUserId || recipientUserId === actorUserId) return null;

  const [r] = await pool.query(
    `INSERT INTO notifications
      (to_user_id, from_user_id, action, node_type, notify_id, message, time, node_url)
     VALUES (?, ?, ?, ?, ?, ?, NOW(),'')`,
    [recipientUserId, actorUserId, type, entityType, entityId, message]
  );

  const id = r.insertId;
  const io = getIO();
  // push to client in real-time
  if (io) {
    // hydrate actor display fields for the client (matches /api/notifications list)
    const [[row]] = await pool.query(
      `
      SELECT
        n.notification_id,
        n.node_type AS entityType,
        n.notify_id   AS entityId,
        n.message,
        n.seen     AS seen,
        n.time  AS createdAt,
        a.user_id     AS actorId,
        a.user_name   AS actorName,
        a.user_picture AS actorAvatar
      FROM notifications n
      JOIN users a ON a.user_id = n.to_user_id
      WHERE n.notification_id = ?
      `,
      [id]
    );
    io.to(`user:${recipientUserId}`).emit('notification:new', row);
  }

  return id;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { createNotification };

