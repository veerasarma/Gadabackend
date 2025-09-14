// utils/liveFanout.js
// Fan-out "live started" notifications using ONLY your schema & helpers.
// notifications: (notification_id, to_user_id, from_user_id, from_user_type,
//                 action, node_type, node_url, notify_id, message, time, seen)

let friendsSvc = null;
try { friendsSvc = require('../friends'); } catch (_) {}

/** Collect recipients from your friends.js (preferred) or from fallback tables. */
async function getRecipients(conn, userId) {
  console.log('getRecipients')
  const uid = Number(userId);
  const [rows] = await conn.query(
    `
    SELECT
      CASE
        WHEN fr.user_one_id = ? THEN fr.user_two_id
        ELSE fr.user_one_id
      END AS friend_id,
      u.user_name                           AS user_name,
      COALESCE(u.user_picture, u.user_picture) AS profileImage
    FROM friends fr
    JOIN users u
      ON u.user_id = CASE
                        WHEN fr.user_one_id = ? THEN fr.user_two_id
                        ELSE fr.user_one_id
                      END
    WHERE (fr.user_one_id = ? OR fr.user_two_id = ?)
      AND fr.status = 1
    ORDER BY u.user_name
    LIMIT 100 
    `,
    [uid, uid, uid, uid]
  );
  return rows;
}

/** Insert notifications in bulk into your `notifications` table. */
async function insertLiveStartNotifications(conn, recipients, { fromUserId, liveId, postId, title }) {
  if (!recipients?.length) return 0;
  const nodeUrl = `posts/${postId}`;      // frontend can route this to the live room
  const notifyId = String(postId);       // good for dedupe if needed
  const rows = recipients.map(toId => ([
    Number(toId.friend_id),                 // to_user_id
    Number(fromUserId),           // from_user_id
    'user',                       // from_user_type
    'live_start',                 // action
    'live',                       // node_type
    nodeUrl,                      // node_url
    notifyId,                     // notify_id
    title || null,                // message
  ]));

  // time = NOW(), seen = '0'
  const [r] = await conn.query(
    `INSERT INTO notifications
      (to_user_id, from_user_id, from_user_type, action, node_type, node_url, notify_id, message, time, seen)
     VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,NOW(),\'0\')').join(',')}`,
    rows.flat()
  );
  
  return r || 0;
}

/**
 * Public helper: call AFTER you commit the live/post creation.
 * Emits socket.io event `notif:new` to each recipient room `user:<id>`.
 */
async function fanOutLiveStart({ pool, io, broadcasterId, liveId, postId, title }) {
  console.log("fanOutLiveStart ")
  const conn = await pool.getConnection();
  try {
    const recipients = await getRecipients(conn, broadcasterId);
    if (!recipients.length) return { recipients: 0 };
    let insdet = await insertLiveStartNotifications(conn, recipients, {
      fromUserId: broadcasterId,
      liveId, postId, title,
    });
    // Realtime push
    if (io) {
      console.log(io,'ioio')
      const [rows] = await conn.query(
        `
        SELECT
          n.notification_id,
          n.to_user_id,
          n.node_type AS entityType,
          n.notify_id   AS entityId,
          n.action,
          n.seen     AS seen,
          n.time  AS createdAt,
          a.user_id     AS actorId,
          a.user_name   AS actorName,
          a.user_picture AS actorAvatar
        FROM notifications n
        JOIN users a ON a.user_id = n.to_user_id
        WHERE n.notification_id >= ?
        `,
        [insdet.insertId]
      );
      
      if(rows.length>0)
      {
        for (const rid of rows) {
          io.to(`user:${rid.to_user_id}`).emit('notification:new', rid);
        }
      }
    }
    return { recipients: recipients.length };
  } finally {
    conn.release();
  }
}

module.exports = { fanOutLiveStart };
