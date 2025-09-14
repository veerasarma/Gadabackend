// routes/live.js
// Drop-in Express router for LIVE feature, using mysql2 pool.
// Assumes you already have: const pool = require('../db'); and ensureAuth middleware.

const express = require('express');
const fs = require('fs/promises'); //
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token'); //
const { fanOutLiveStart } = require('../utils/liveFanout');
const { getIO } = require('../socket');

// Adjust these requires to match your project structure
const pool = require('../config/db');                 // mysql2 pool (promise or callback API)
const { ensureAuth } = require('../middlewares/auth');
// ---- Agora config via env ----
const AGORA_APP_ID    = process.env.AGORA_APP_ID || '';
const AGORA_AUTH_MODE = (process.env.AGORA_AUTH_MODE || 'appid').toLowerCase(); // 'appid' | 'token'
const AGORA_APP_CERT = process.env.AGORA_APP_CERTIFICATE || ''; // needed only for token mode
const TOKEN_EXPIRE_SECONDS = 60 * 60; // 1 hour


function genUid() {
    // positive 32-bit int (non-zero). Avoid 0 in token mode.
    return Math.floor(1 + Math.random() * 2147483646);
  }
  function sanitizeChannelName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }
  
  // ---------- HOST (publisher) join info ----------
  router.get('/agora/host-join', ensureAuth, async (req, res) => {
    try {
      if (!AGORA_APP_ID || !AGORA_APP_CERT) {
        return res.status(500).json({ error: 'AGORA_APP_ID / AGORA_APP_CERTIFICATE missing' });
      }
  
      const postId = Number(req.query.postId || 0);
      if (!postId) return res.status(400).json({ error: 'postId required' });
  
      // Read current live row
      const [rows] = await pool.query(
        `SELECT live_id, agora_channel_name, agora_uid, live_ended
           FROM posts_live
          WHERE post_id = ? AND live_ended = '0'
          LIMIT 1`,
        [postId]
      );
      let live = rows[0];
      if (!live) {
        return res.status(404).json({ error: 'Live not found or already ended' });
      }
  
      // Ensure channel + uid exist
      let channelName = sanitizeChannelName(live.agora_channel_name);
      let uid = Number(live.agora_uid || 0);
      let needUpdate = false;
  
      if (!channelName) {
        channelName = `live_${postId}`; // deterministic per post
        needUpdate = true;
      }
      if (!uid) {
        uid = genUid();
        needUpdate = true;
      }
  
      if (needUpdate) {
        await pool.query(
          `UPDATE posts_live
              SET agora_channel_name = ?, agora_uid = ?
            WHERE live_id = ?`,
          [channelName, uid, live.live_id]
        );
      }
  
      const now = Math.floor(Date.now() / 1000);
      const expire = now + TOKEN_EXPIRE_SECONDS;
      const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_APP_CERT,
        channelName,
        uid,
        RtcRole.PUBLISHER, // host
        expire
      );
  
      return res.json({ appId: AGORA_APP_ID, channelName, uid, token });
    } catch (e) {
      console.error('[GET /api/live/agora/host-join]', e);
      res.status(500).json({ error: 'Failed to create host token' });
    }
  });
  
  // ---------- VIEWER (audience) join info ----------
  router.get('/agora/join-info', async (req, res) => {
    try {
      if (!AGORA_APP_ID || !AGORA_APP_CERT) {
        return res.status(500).json({ error: 'AGORA_APP_ID / AGORA_APP_CERTIFICATE missing' });
      }
      const postId = Number(req.query.postId || 0);
      if (!postId) return res.status(400).json({ error: 'postId required' });
  
      // Active live row
      const [rows] = await pool.query(
        `SELECT agora_channel_name
           FROM posts_live
          WHERE post_id = ? AND live_ended = '0'
          LIMIT 1`,
        [postId]
      );
      const live = rows[0];
      if (!live) return res.status(404).json({ error: 'Live not found or ended' });
  
      const channelName = sanitizeChannelName(live.agora_channel_name);
      if (!channelName) return res.status(500).json({ error: 'Channel missing' });
  
      const uid = genUid(); // viewer UID
      const now = Math.floor(Date.now() / 1000);
      const expire = now + TOKEN_EXPIRE_SECONDS;
  
      const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_APP_CERT,
        channelName,
        uid,
        RtcRole.SUBSCRIBER, // 🔑 viewer/audience
        expire
      );
  
      res.json({ appId: AGORA_APP_ID, channelName, uid, token });
    } catch (e) {
      console.error('[GET /api/live/agora/join-info]', e);
      res.status(500).json({ error: 'Failed to create viewer token' });
    }
  });
// -------- helpers ------------------------------------------------------------

function toRowOrNull(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}


const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads');

// Try to load node-canvas for auto thumbs (optional)
let createCanvas = null;
try { ({ createCanvas } = require('canvas')); } catch (_) { /* optional */ }

// async function ensureDir(dir) {
//   await fs.mkdir(dir, { recursive: true });
// }

function isDataUrlPng(s) {
  return typeof s === 'string' && s.startsWith('data:image/png;base64,');
}

// Save PNG data URL into /uploads/<subdir>, return relative path like "live_thumbs/file.png"
async function saveDataUrlPNG(dataUrl, subdir = 'live_thumbs', basename = '') {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Invalid PNG data URL');
  const buf = Buffer.from(m[1], 'base64');
  const dirAbs = path.join(UPLOADS_ROOT, subdir);
//   await ensureDir(dirAbs);
  const filename = `${basename}-${Date.now()}.png`;
  await fs.writeFile(path.join(dirAbs, filename), buf);
  return `${subdir}/${filename}`;
}

async function canvasToPNGBuffer(canvas) {
    // Try sync / mime-type form (newer node-canvas)
    try {
      if (typeof canvas.toBuffer === 'function' && canvas.toBuffer.length === 0) {
        const buf = canvas.toBuffer('image/png');
        if (buf) return buf;
      }
    } catch (_) { /* fall through */ }
  
    // Try callback signature: toBuffer((err, buf) => ...)
    if (typeof canvas.toBuffer === 'function' && canvas.toBuffer.length >= 1) {
      return await new Promise((resolve, reject) => {
        try {
          canvas.toBuffer((err, buf) => (err ? reject(err) : resolve(buf)));
        } catch (e) {
          reject(e);
        }
      });
    }
  
    // Fallback: PNG stream
    return await new Promise((resolve, reject) => {
      try {
        const chunks = [];
        const stream = canvas.createPNGStream();
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      } catch (e) {
        reject(e);
      }
    });
  }

// Auto-generate a default 1280x720 PNG thumbnail
async function generateDefaultLiveThumb({ postId, channelName }) {
    if (!createCanvas) {
      // Static fallback (ensure this exists under /uploads/defaults/live-default.png)
      return 'defaults/live-default.png';
    }
    const W = 1280, H = 720;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
  
    // gradient bg
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#111827');
    g.addColorStop(1, '#1f2937');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  
    // live pill
    ctx.fillStyle = '#ef4444';
    const x = 40, y = 40, bw = 140, bh = 56, r = 14;
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, bw, bh, r); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + bw, y, x + bw, y + bh, r);
      ctx.arcTo(x + bw, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r);
      ctx.arcTo(x, y, x + bw, y, r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.textBaseline = 'middle';
    ctx.fillText('LIVE', x + 18, y + bh / 2);
  
    // labels
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 44px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText(`Post #${postId}`, 40, 40 + bh + 80);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText(`Channel: ${channelName}`, 40, 40 + bh + 80 + 52);
  
    const dirAbs = path.join(UPLOADS_ROOT, 'live_thumbs');
    await ensureDir(dirAbs);
    const filename = `post-${postId}-${Date.now()}.png`;
  
    // ✅ Use robust buffer conversion (works across node-canvas versions)
    const buf = await canvasToPNGBuffer(canvas);
    await fs.writeFile(path.join(dirAbs, filename), buf);
  
    return `live_thumbs/${filename}`;
  }

// ---------------------- START LIVE ----------------------
router.post('/start', ensureAuth, async (req, res) => {
  const userId = Number(req.user?.userId || 0);
  const { postId, channelName, agoraUid, thumbnailDataUrl,title = '🔴 Live now' } = req.body || {};
  const io = getIO();

  if (!postId || !channelName || !agoraUid) {
    return res.status(400).json({ ok: false, error: 'Missing postId/channelName/agoraUid' });
  }

  try {
    // 1) Decide thumbnail path
    let thumbPath = null;
    if (isDataUrlPng(thumbnailDataUrl)) {
      try {
        thumbPath = await saveDataUrlPNG(thumbnailDataUrl, 'live_thumbs', `post-${postId}`);
      } catch (e) {
        console.warn('[live/start] save dataURL failed:', e?.message);
      }
    }
    if (!thumbPath) {
      try {
        thumbPath = await generateDefaultLiveThumb({ postId, channelName });
      } catch (e) {
        console.warn('[live/start] auto thumbnail failed:', e?.message);
        thumbPath = 'defaults/live-default.png'; // ensure exists under /uploads
      }
    }

    // 2) Upsert posts_live (use last active if exists)
    const [activeRows] = await pool.query(
      `SELECT live_id FROM posts_live
        WHERE post_id = ? AND live_ended = '0'
        ORDER BY live_id DESC
        LIMIT 1`,
      [postId]
    );

    if (activeRows.length) {
      const liveId = activeRows[0].live_id;
      await pool.query(
        `UPDATE posts_live
            SET agora_uid = ?, agora_channel_name = ?, video_thumbnail = ?, live_ended = '0'
          WHERE live_id = ?`,
        [agoraUid, channelName, thumbPath || '', liveId]
      );
       
    fanOutLiveStart({ pool, io, broadcasterId: userId, postId,liveId, title })
      .catch(err => console.error('fanOutLiveStart error', err));
      return res.json({ ok: true, live: { liveId, postId, channelName, agoraUid, video_thumbnail: thumbPath || '' } });
    }

    const [ins] = await pool.query(
      `INSERT INTO posts_live
         (post_id, video_thumbnail, agora_uid, agora_channel_name, live_ended, live_recorded)
       VALUES (?, ?, ?, ?, '0', '0')`,
      [postId, thumbPath || '', agoraUid, channelName]
    );
 
    
    fanOutLiveStart({ pool, io, broadcasterId: userId, postId,liveId: ins.insertId, title })
      .catch(err => console.error('fanOutLiveStart error', err));


    return res.json({
      ok: true,
      live: { liveId: ins.insertId, postId, channelName, agoraUid, video_thumbnail: thumbPath || '' }
    });
  } catch (e) {
    console.error('[live/start]', e);
    res.status(500).json({ ok: false, error: 'Failed to start live' });
  }
});

/**
 * POST /live/stop
 * body: { postId:number, thumbnailDataUrl?:string }
 * Marks live_ended = '1' and optionally updates video_thumbnail; clears viewers.
 */
router.post('/stop', ensureAuth, async (req, res) => {
  const { postId, thumbnailDataUrl } = req.body || {};
  if (!postId) return res.status(400).json({ ok: false, error: 'Missing postId' });

  try {
    let thumbPath = null;
    if (thumbnailDataUrl) {
      thumbPath = await saveDataUrlPNG(thumbnailDataUrl).catch(() => null);
    }

    await pool.query(
      `UPDATE posts_live
          SET live_ended = '1' ${thumbPath ? ', video_thumbnail = ?' : ''}
        WHERE post_id = ? AND live_ended = '0'`,
      thumbPath ? [thumbPath, postId] : [postId]
    );

    // Remove all viewer rows for this post
    await pool.query(`DELETE FROM posts_live_users WHERE post_id = ?`, [postId]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[live/stop]', e);
    res.status(500).json({ ok: false, error: 'Failed to stop live' });
  }
});

/**
 * POST /live/join
 * body: { postId:number }
 * Adds (user_id, post_id) into posts_live_users (dedup via unique key).
 */
router.post('/join', ensureAuth, async (req, res) => {
  const userId = Number(req.user?.userId || 0);
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ ok: false, error: 'Missing postId' });

  try {
    // No-op if duplicate
    await pool.query(
      `INSERT INTO posts_live_users (user_id, post_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE post_id = VALUES(post_id)`,
      [userId, postId]
    );

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM posts_live_users WHERE post_id = ?`,
      [postId]
    );

    res.json({ ok: true, viewers: Number(countRow?.c || 0) });
  } catch (e) {
    console.error('[live/join]', e);
    res.status(500).json({ ok: false, error: 'Failed to join' });
  }
});

/**
 * POST /live/leave
 * body: { postId:number }
 * Removes viewer row.
 */
router.post('/leave', ensureAuth, async (req, res) => {
  const userId = Number(req.user?.userId || 0);
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ ok: false, error: 'Missing postId' });

  try {
    await pool.query(
      `DELETE FROM posts_live_users WHERE user_id = ? AND post_id = ?`,
      [userId, postId]
    );
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM posts_live_users WHERE post_id = ?`,
      [postId]
    );
    res.json({ ok: true, viewers: Number(countRow?.c || 0) });
  } catch (e) {
    console.error('[live/leave]', e);
    res.status(500).json({ ok: false, error: 'Failed to leave' });
  }
});

/**
 * GET /live/for-posts?ids=1,2,3
 * Returns a map of postId -> { live:boolean, viewers:number, channelName?:string }
 */
router.get('/for-posts', ensureAuth, async (req, res) => {
  const idsParam = String(req.query.ids || '').trim();
  if (!idsParam) return res.json({ data: {} });
  const ids = idsParam.split(',').map(s => Number(s)).filter(Boolean);
  if (!ids.length) return res.json({ data: {} });

  try {
    // Active lives for these posts
    const [liveRows] = await pool.query(
      `SELECT post_id, agora_channel_name
         FROM posts_live
        WHERE live_ended = '0' AND post_id IN (?)`,
      [ids]
    );

    // Viewer counts
    const [viewerRows] = await pool.query(
      `SELECT post_id, COUNT(*) AS c
         FROM posts_live_users
        WHERE post_id IN (?)
        GROUP BY post_id`,
      [ids]
    );
    const map = {};
    const liveMap = new Map(liveRows.map(r => [Number(r.post_id), r.agora_channel_name]));
    const vcMap   = new Map(viewerRows.map(r => [Number(r.post_id), Number(r.c)]));

    for (const id of ids) {
      const ch = liveMap.get(id);
      map[id] = {
        live: Boolean(ch),
        viewers: vcMap.get(id) || 0,
        ...(ch ? { channelName: ch } : {})
      };
    }

    res.json({ data: map });
  } catch (e) {
    console.error('[live/for-posts]', e);
    res.status(500).json({ error: 'Failed to check live status' });
  }
});

router.get('/status', ensureAuth, async (req, res) => {
    try {
      const ids = parseIds(req.query.postIds);
      if (!ids.length) {
        return res.status(400).json({ error: 'postIds required' });
      }
  
      // Start with "not live" defaults
      const out = {};
      for (const id of ids) out[id] = { live: false, viewers: 0 };
  
      // Fetch live rows for these posts
      const [liveRows] = await pool.query(
        `SELECT post_id, video_thumbnail, agora_uid, agora_channel_name, live_ended
           FROM posts_live
          WHERE post_id IN (?)`,
        [ids]
      );
  
      // Attach live info when live_ended = '0'
      for (const r of liveRows) {
        const isLive = String(r.live_ended || '1') === '0';
        if (isLive) {
          out[r.post_id] = {
            live: true,
            channelName: r.agora_channel_name || null,
            uid: r.agora_uid != null ? Number(r.agora_uid) : null,
            thumbnail: r.video_thumbnail || null,
            viewers: 0,   // filled below
          };
        }
      }
  
      // Try to count "fresh" viewers (presence) in posts_live_users.
      // Prefer `last_seen` within 45s. If that column isn't there,
      // fall back to counting all rows for the post_id.
      let viewerCounts = [];
      try {
        const [rows] = await pool.query(
          `SELECT post_id, COUNT(*) AS c
             FROM posts_live_users
            WHERE post_id IN (?)
              AND last_seen >= (NOW() - INTERVAL 45 SECOND)
            GROUP BY post_id`,
          [ids]
        );
        viewerCounts = rows;
      } catch (e) {
        // No last_seen column? Try a generic fallback without timestamp window.
        try {
          const [rows2] = await pool.query(
            `SELECT post_id, COUNT(*) AS c
               FROM posts_live_users
              WHERE post_id IN (?)
              GROUP BY post_id`,
            [ids]
          );
          viewerCounts = rows2;
        } catch (e2) {
          // Presence table missing or schema is different → ignore silently
          viewerCounts = [];
        }
      }
  
      for (const r of viewerCounts) {
        if (out[r.post_id]) {
          out[r.post_id].viewers = Number(r.c || 0);
        }
      }
  
      return res.json(out);
    } catch (err) {
      console.error('[GET /api/live/status] failed:', err);
      return res.status(500).json({ error: 'Failed to fetch live status' });
    }
  });
  
  /**
   * POST /api/live/heartbeat
   * body: { postId }
   * Upserts viewer presence (no `role`).
   * Schema tolerant: prefers `last_seen` column; if missing, tries `time`.
   */
  router.post('/heartbeat', ensureAuth, async (req, res) => {
    const userId = Number(req.user?.userId || 0);
    const postId = Number(req.body?.postId || 0);
  
    if (!userId || !postId) {
      return res.status(400).json({ error: 'postId required' });
    }
  
    try {
      // First: try to update last_seen
      let [r] = await pool.query(
        `UPDATE posts_live_users
            SET last_seen = NOW()
          WHERE post_id = ? AND user_id = ?`,
        [postId, userId]
      );
  
      // If nothing updated, insert a row with last_seen if column exists
      if (r.affectedRows === 0) {
        try {
          await pool.query(
            `INSERT INTO posts_live_users (post_id, user_id, last_seen)
             VALUES (?, ?, NOW())`,
            [postId, userId]
          );
        } catch (eIns) {
          // Maybe table doesn't have last_seen; use a generic timestamp column named `time`
          try {
            // 1) try update
            const [r2] = await pool.query(
              `UPDATE posts_live_users
                  SET time = NOW()
                WHERE post_id = ? AND user_id = ?`,
              [postId, userId]
            );
            if (r2.affectedRows === 0) {
              // 2) try insert with `time`
              await pool.query(
                `INSERT INTO posts_live_users (post_id, user_id, time)
                 VALUES (?, ?, NOW())`,
                [postId, userId]
              );
            }
          } catch (eAlt) {
            // As a last resort, try insert ONLY (some schemas auto-manage updated_at)
            await pool.query(
              `INSERT INTO posts_live_users (post_id, user_id)
               VALUES (?, ?)`,
              [postId, userId]
            );
          }
        }
      }
  
      return res.json({ ok: true });
    } catch (err) {
      console.error('[POST /api/live/heartbeat] failed:', err);
      return res.status(500).json({ error: 'Failed to update presence' });
    }
  });

/**
 * GET /live/:postId
 * Returns the active live row for a post (if any).
 */
router.get('/:postId', ensureAuth, async (req, res) => {
  const postId = Number(req.params.postId || 0);
  if (!postId) return res.status(400).json({ ok: false, error: 'Bad postId' });

  try {
    const [rows] = await pool.query(
      `SELECT live_id, post_id, video_thumbnail, agora_uid, agora_channel_name,
              agora_resource_id, agora_sid, agora_file, live_ended, live_recorded
         FROM posts_live
        WHERE post_id = ? AND live_ended = '0'
        ORDER BY live_id DESC
        LIMIT 1`,
      [postId]
    );
    const row = toRowOrNull(rows);
    if (!row) return res.json({ data: null });
    res.json({ data: row });
  } catch (e) {
    console.error('[live/:postId]', e);
    res.status(500).json({ ok: false, error: 'Failed to fetch live' });
  }
});

/**
 * POST /live/thumb
 * body: { postId:number, dataUrl:string }
 * Stores a PNG and updates posts_live.video_thumbnail on the active row.
 */
router.post('/thumb', ensureAuth, async (req, res) => {
  const { postId, dataUrl } = req.body || {};
  if (!postId || !dataUrl) return res.status(400).json({ ok: false, error: 'Missing postId/dataUrl' });

  try {
    const rel = await saveDataUrlPNG(dataUrl);
    if (!rel) return res.status(400).json({ ok: false, error: 'Bad dataUrl' });

    await pool.query(
      `UPDATE posts_live
          SET video_thumbnail = ?
        WHERE post_id = ? AND live_ended = '0'`,
      [rel, postId]
    );
    res.json({ ok: true, video_thumbnail: rel });
  } catch (e) {
    console.error('[live/thumb]', e);
    res.status(500).json({ ok: false, error: 'Failed to save thumbnail' });
  }
});


// // GET /api/live/agora/join-info?postId=123
// router.get('/agora/join-info', async (req, res) => {
//     try {
//       const postId = Number(req.query.postId);
//       if (!postId) return res.status(400).json({ error: 'postId required' });
  
//       // active live row for post
//       const [rows] = await pool.query(
//         `SELECT agora_channel_name
//            FROM posts_live
//           WHERE post_id = ? AND live_ended = '0'
//           LIMIT 1`,
//         [postId]
//       );
//       const row = rows[0];
//       if (!row) return res.status(404).json({ error: 'Live not found or already ended' });
  
//       const channelName = row.agora_channel_name;
//       const uid = Math.floor(Math.random() * 2_000_000_000); // viewer uid
  
//       let token = null;
//       if (AGORA_APP_ID && AGORA_APP_CERT) {
//         const now = Math.floor(Date.now() / 1000);
//         const expire = now + TOKEN_EXPIRE_SECONDS;
//         token = RtcTokenBuilder.buildTokenWithUid(
//           AGORA_APP_ID,
//           AGORA_APP_CERT,
//           channelName,
//           uid,
//           RtcRole.SUBSCRIBER,
//           expire
//         );
//       }
  
//       return res.json({
//         appId: AGORA_APP_ID || null,
//         channelName,
//         uid,
//         token,  // can be null if you don't use tokens
//         // If you also have an HLS URL, include it here: hlsUrl: 'https://.../index.m3u8'
//       });
//     } catch (e) {
//       console.error('[GET /live/agora/join-info]', e);
//       res.status(500).json({ error: 'Failed to create join info' });
//     }
//   });


module.exports = router;
