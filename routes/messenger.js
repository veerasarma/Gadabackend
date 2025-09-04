// routes/messenger.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const { getIO } = require('../socket');
const router = express.Router();
const { createNotification } = require('../services/notificationService');
const crypto = require('crypto');

/* ---------- uploads (images / voice) ---------- */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dir = path.join(process.cwd(), 'uploads', 'messages', year, month);
    ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const upload = multer({ storage });

/* ---------- helpers ---------- */
async function findOrCreateDirectConversation(userA, userB, conn) {
  // existing 1:1 not group
  const [rows] = await conn.query(
    `
    SELECT cu.conversation_id
      FROM conversations_users cu
      JOIN conversations_users cu2
        ON cu2.conversation_id = cu.conversation_id
      JOIN conversations c
        ON c.conversation_id = cu.conversation_id AND c.is_group = '0'
     WHERE cu.user_id = ? AND cu2.user_id = ?
     LIMIT 1
    `,
    [userA, userB]
  );
  if (rows.length) return rows[0].conversation_id;

  // create
  const [ins] = await conn.query(
    `INSERT INTO conversations (last_message_id, color, node_id, node_type, is_group)
     VALUES (0, NULL, NULL, NULL, '0')`
  );
  const conversationId = ins.insertId;
  await conn.query(
    `INSERT INTO conversations_users (conversation_id, user_id, seen, typing, deleted)
     VALUES (?, ?, '1', '0', '0'), (?, ?, '0', '0', '0')`,
    [conversationId, userA, conversationId, userB]
  );
  return conversationId;
}

async function emitToPeers(conversationId, senderId, event, payload) {
    const [members] = await pool.query(
      `SELECT user_id FROM conversations_users WHERE conversation_id=?`,
      [conversationId]
    );
    const io = getIO();
    for (const row of members) {
      const uid = Number(row.user_id);
      if (uid === Number(senderId)) continue;
      io.to(`user:${uid}`).emit(event, payload);
    }
  }

/* ---------- NEW: search people to start a chat ---------- */
/**
 * GET /api/messenger/users/suggest?q=sa
 * Returns small list to pick a user from.
 */
router.get('/users/suggest', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json([]);

  try {
    const [rows] = await pool.query(
      `
      SELECT u.user_id   AS id,
             u.user_name AS username,
             CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS fullName,
             u.user_picture AS avatar
        FROM users u
       WHERE u.user_id <> ?
         AND (
              LOWER(u.user_name)      LIKE CONCAT(?, '%')
           OR LOWER(u.user_firstname) LIKE CONCAT(?, '%')
           OR LOWER(u.user_lastname)  LIKE CONCAT(?, '%')
         )
       ORDER BY u.user_id DESC
       LIMIT 10
      `,
      [me, q, q, q]
    );
    res.json(rows.map(r => ({
      id: r.id, username: r.username,
      fullName: r.fullName || r.username,
      avatar: r.avatar || null
    })));
  } catch (e) {
    console.error('[GET /messenger/users/suggest]', e);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

/* ---------- conversations list ---------- */
router.get('/conversations', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT
        cu.conversation_id,
        cu.seen,
        CASE WHEN cu2.user_id IS NULL THEN cu.user_id ELSE cu2.user_id END AS peer_id,
        u.user_name AS peer_username,
        CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS peer_fullname,
        u.user_picture AS peer_avatar,
        c.last_message_id
      FROM conversations_users cu
      LEFT JOIN conversations_users cu2
        ON cu2.conversation_id = cu.conversation_id AND cu2.user_id <> cu.user_id
      LEFT JOIN users u ON u.user_id = cu2.user_id
      JOIN conversations c ON c.conversation_id = cu.conversation_id
      WHERE cu.user_id = ? AND (cu.deleted = '0')
      ORDER BY c.last_message_id DESC
      `,
      [me]
    );

    if (!rows.length) return res.json([]);

    const lastIds = rows.map(r => r.last_message_id).filter(Boolean);
    const mapLast = new Map();
    if (lastIds.length) {
      const [lasts] = await conn.query(
        `SELECT message_id, conversation_id, user_id, message, image, voice_note, time
           FROM conversations_messages
          WHERE message_id IN (?)`,
        [lastIds]
      );
      for (const m of lasts) mapLast.set(m.message_id, m);
    }

    const out = rows.map(r => {
      const last = mapLast.get(r.last_message_id) || null;
      const lastFromPeer = last ? Number(last.user_id) !== me : false;
      const unread = last && lastFromPeer && r.seen === '0';
      return {
        conversationId: r.conversation_id,
        peer: {
          id: r.peer_id,
          username: r.peer_username,
          fullName: r.peer_fullname || r.peer_username,
          avatar: r.peer_avatar || null
        },
        lastMessage: last?.message || (last?.image ? '[image]' : last?.voice_note ? '[voice]' : ''),
        lastTime: last?.time || null,
        unread: Boolean(unread),
        typing: false
      };
    });

    res.json(out);
  } catch (e) {
    console.error('[GET /messenger/conversations]', e);
    res.status(500).json({ error: 'Failed to load conversations' });
  } finally {
    conn.release();
  }
});

/* ---------- open or create direct conversation ---------- */
router.post('/conversations/open', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const peerId = Number(req.body.userId);
  if (!Number.isFinite(peerId) || peerId === me) {
    return res.status(400).json({ error: 'Bad peer id' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const conversationId = await findOrCreateDirectConversation(me, peerId, conn);
    await conn.commit();
    res.json({ conversationId });
  } catch (e) {
    await conn.rollback();
    console.error('[POST /messenger/conversations/open]', e);
    res.status(500).json({ error: 'Failed to open conversation' });
  } finally {
    conn.release();
  }
});

/* ---------- messages (paged) ---------- */
router.get('/conversations/:id/messages', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const conversationId = Number(req.params.id);
  const limit = Math.min(50, Math.max(10, Number(req.query.limit) || 20));
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;

  if (!Number.isFinite(conversationId)) return res.status(400).json({ error: 'Bad conversation id' });

  const conn = await pool.getConnection();
  try {
    const [[member]] = await conn.query(
      `SELECT 1 FROM conversations_users WHERE conversation_id=? AND user_id=? LIMIT 1`,
      [conversationId, me]
    );
    if (!member) return res.status(403).json({ error: 'Forbidden' });

    const params = [conversationId];
    let where = `conversation_id = ?`;
    if (cursor) { where += ` AND message_id < ?`; params.push(cursor); }

    const [rows] = await conn.query(
      `
      SELECT message_id, conversation_id, user_id, message, image, voice_note, time
        FROM conversations_messages
       WHERE ${where}
       ORDER BY message_id DESC
       LIMIT ${limit}
      `,
      params
    );

    const items = rows.reverse().map(r => ({
      id: r.message_id,
      authorId: r.user_id,
      text: r.message,
      image: r.image || null,
      voice: r.voice_note || null,
      time: r.time
    }));
    const nextCursor = items.length ? items[0].id : null;

    res.json({ items, nextCursor });
  } catch (e) {
    console.error('[GET /messenger/conversations/:id/messages]', e);
    res.status(500).json({ error: 'Failed to load messages' });
  } finally {
    conn.release();
  }
});

/* ---------- send message ---------- */
router.post(
  '/conversations/:id/messages',
  ensureAuth,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'voice', maxCount: 1 }]),
  async (req, res) => {
    const me = Number(req.user.userId);
    const conversationId = Number(req.params.id);
    const text = (req.body.message || '').toString();

    const imageFile = req.files?.image?.[0];
    const voiceFile = req.files?.voice?.[0];

    if (!Number.isFinite(conversationId)) return res.status(400).json({ error: 'Bad conversation id' });
    if (!text && !imageFile && !voiceFile) return res.status(400).json({ error: 'Empty message' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[member]] = await conn.query(
        `SELECT 1 FROM conversations_users WHERE conversation_id=? AND user_id=? LIMIT 1`,
        [conversationId, me]
      );

      const [[member1]] = await conn.query(
        `SELECT user_id FROM conversations_users WHERE conversation_id=? AND user_id!=? LIMIT 1`,
        [conversationId,me]
      );

      if (!member || !member1) {
        await conn.rollback();
        return res.status(403).json({ error: 'Forbidden' });
      }

      const imgPath = imageFile ? path.relative(path.join(process.cwd(), 'uploads'), imageFile.path).replace(/\\/g, '/') : '';
      const voicePath = voiceFile ? path.relative(path.join(process.cwd(), 'uploads'), voiceFile.path).replace(/\\/g, '/') : '';

      const [ins] = await conn.query(
        `INSERT INTO conversations_messages
           (conversation_id, user_id, message, image, voice_note, time)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [conversationId, me, text, imgPath, voicePath]
      );
      const messageId = ins.insertId;

      await conn.query(`UPDATE conversations SET last_message_id=? WHERE conversation_id=?`, [messageId, conversationId]);
      await conn.query(
        `UPDATE conversations_users
            SET seen = CASE WHEN user_id = ? THEN '1' ELSE '0' END,
                typing = '0'
          WHERE conversation_id = ?`,
        [me, conversationId]
      );

      await conn.commit();

      const msgDTO = {
        id: messageId,
        conversationId,
        authorId: me,
        text,
        image: imgPath || null,
        voice: voicePath || null,
        time: new Date().toISOString(),
      };

      const payload = {
        recipientId: member1.user_id,
        userId:me,
        type: 'new_message',
        entityType: 'message',
        entityId: messageId,
        meta: { messageId },
      };

     
      if (createNotification) {
        // console.log("notification section")
        // Use your service (emits socket + returns enriched row)
        createNotification(payload).catch(err =>
          console.error('[notif] post_like helper failed', err)
        );
      } 


      // realtime: deliver to peers + bump their left list
      const preview =
        msgDTO.text || (msgDTO.image ? '[image]' : msgDTO.voice ? '[voice]' : '');
      await emitToPeers(conversationId, me, 'message:new', { message: msgDTO });
      await emitToPeers(conversationId, me, 'conversation:update', {
        conversationId,
        lastMessage: preview,
        lastTime: msgDTO.time,
      });
      return res.status(201).json(msgDTO);
    //   res.status(201).json({
    //     id: messageId,
    //     authorId: me,
    //     text,
    //     image: imgPath || null,
    //     voice: voicePath || null,
    //     time: new Date().toISOString()
    //   });
    } catch (e) {
      await conn.rollback();
      console.error('[POST /messenger/conversations/:id/messages]', e);
      res.status(500).json({ error: 'Failed to send message' });
    } finally {
      conn.release();
    }
  }
);

/* ---------- mark seen ---------- */
router.post('/conversations/:id/seen', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const conversationId = Number(req.params.id);
  try {
    await pool.query(
      `UPDATE conversations_users SET seen='1' WHERE conversation_id=? AND user_id=?`,
      [conversationId, me]
    );
    // realtime
    await emitToPeers(conversationId, me, 'message:seen', {
        conversationId,
        userId: me,
        seenAt: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /messenger/conversations/:id/seen]', e);
    res.status(500).json({ error: 'Failed to mark seen' });
  }
});

/* ---------- typing ---------- */
router.post('/conversations/:id/typing', ensureAuth, async (req, res) => {
  const me = Number(req.user.userId);
  const conversationId = Number(req.params.id);
  const typing = req.body.typing ? '1' : '0';
  try {
    await pool.query(
      `UPDATE conversations_users SET typing=? WHERE conversation_id=? AND user_id=?`,
      [typing, conversationId, me]
    );

    await emitToPeers(conversationId, me, 'message:typing', {
        conversationId,
        userId: me,
        typing,
      });
  
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /messenger/conversations/:id/typing]', e);
    res.status(500).json({ error: 'Failed to set typing' });
  }
});


// Helper
function tableFor(type) { return type === 'video' ? 'conversations_calls_video' : 'conversations_calls_audio'; }
function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

// START call
router.post('/call/start', ensureAuth, async (req, res) => {
  const { conversationId, toUserId, type } = req.body || {};
  const fromUserId = req.user.userId;
  if (!toUserId || !type) return res.status(400).json({ error: 'Missing fields' });

  const room = crypto.randomBytes(16).toString('hex');
  const table = tableFor(type);
  const conn = await pool.getConnection();
  try {
    const [ins] = await conn.query(
      `INSERT INTO ${table} (from_user_id, from_user_token, to_user_id, to_user_token, room, answered, declined, created_time, updated_time)
       VALUES (?, '', ?, '', ?, '0', '0', ?, ?)`,
      [fromUserId, toUserId, room, nowSql(), nowSql()]
    );
    res.json({ room, callId: ins.insertId });
  } finally { conn.release(); }
});

// ANSWER call
router.post('/call/answer', ensureAuth, async (req, res) => {
  const { callId, type } = req.body || {};
  const table = tableFor(type);
  await pool.query(
    `UPDATE ${table} SET answered='1', updated_time=? WHERE call_id=?`,
    [nowSql(), callId]
  );
  res.json({ ok: true });
});

// END/DECLINE call
router.post('/call/end', ensureAuth, async (req, res) => {
  const { callId, type, declined } = req.body || {};
  const table = tableFor(type);
  await pool.query(
    `UPDATE ${table} SET declined=?, updated_time=? WHERE call_id=?`,
    [declined ? '1' : '0', nowSql(), callId]
  );
  res.json({ ok: true });
});

module.exports = router;
module.exports = router;
