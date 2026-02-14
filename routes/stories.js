// stories.js — DROP-IN
// Requires: express, multer, path, fs; and a mysql2/promise pool passed in.

// const express = require('express');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');
// const  pool  = require('../config/db'); // adjust to your db path
// const {ensureAuth} = require('../middlewares/auth')

// const router = express.Router();

// const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'photos');

// const STORIES_EXPIRE_HOURS = 24; // set to 0/false to disable time filter

// function asInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     const now = new Date();
//     const folder = path.join(UPLOAD_ROOT, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
//     fs.mkdirSync(folder, { recursive: true });
//     cb(null, folder);
//   },
//   filename: (req, file, cb) => {
//     const ext = path.extname(file.originalname || '.jpg');
//     cb(null, `GADA_${Math.random().toString(16).slice(2)}${ext}`);
//   },
// });
// const upload = multer({ storage });

// function formatMySQLDate(d) {
//   const p = (n) => String(n).padStart(2, '0');
//   return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
// }
// function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

//   // CREATE (file + meta)
//   router.post('/', ensureAuth, upload.single('file'), async (req, res) => {
//     const conn = await pool.getConnection();
//     try {
//       if (!req.file) return res.status(400).json({ error: 'file is required' });

//       const meta = safeJSON(req.body?.meta) || {};
//       const userId = req.user.userId; // adapt if your auth uses a different key
//       const now = new Date();

//       // relative path like photos/2025/09/GADA_xxx.jpg
//       const photosIdx = req.file.path.lastIndexOf(path.sep + 'photos' + path.sep);
//       const rel = photosIdx >= 0
//         ? req.file.path.substring(photosIdx + 1).replace(/\\/g, '/')
//         : 'photos/' + path.basename(req.file.path);

//       const isPhoto = req.file.mimetype.startsWith('image/') ? '1' : '0';
//       const caption = (meta.caption || '').toString();
//       const overlays = meta.overlays ? JSON.stringify(meta.overlays) : null;
//       const musicUrl = meta.musicUrl || null;
//       const musicVolume = typeof meta.musicVolume === 'number' ? meta.musicVolume : 0.8;

//       await conn.beginTransaction();

//       // Parent story row
//       const [storyR] = await conn.execute(
//         'INSERT INTO `stories` (`user_id`, `is_ads`, `time`) VALUES (?, ?, NOW())',
//         [userId, '0']
//       );
//       const storyId = storyR.insertId;

//       // Media row including caption (text) + new fields
//       await conn.execute(
//         `INSERT INTO stories_media
//          (story_id, source, is_photo, text, overlays, music_url, music_volume, time)
//          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
//         [storyId, rel, isPhoto, caption, overlays, musicUrl, musicVolume]
//       );

//       await conn.commit();

//       // Respond with a shape the frontend expects
//       res.status(201).json({
//         storyId,
//         userId,
//         url: '/' + rel, // your frontend prefixes with `${API_BASE_URL}/uploads`
//         type: isPhoto === '1' ? 'image' : 'video',
//         meta: {
//           caption: caption || undefined,
//           overlays: meta.overlays || [],
//           musicUrl: musicUrl || undefined,
//           musicVolume
//         }
//       });
//     } catch (e) {
//       try { await conn.rollback(); } catch {}
//       console.error('POST /stories error', e);
//       return res.status(500).json({ error: 'Internal server error' });
//     } finally {
//       conn.release();
//     }
//   });

//   // LIST stories (map DB → viewer-friendly shape)
//   router.get('/', ensureAuth, async (req, res) => {
//     try {
//       // If you want to limit to last 24h, uncomment the WHERE and add the param in query.
//       const [rows] = await pool.query(
//         `
//         SELECT s.story_id,
//                s.user_id,
//                s.time              AS story_time,
//                u.user_name         AS username,
//                u.user_picture      AS avatar,
//                m.media_id,
//                m.source,
//                m.is_photo,
//                m.text,             -- caption
//                m.overlays,
//                m.music_url,
//                m.music_volume,
//                m.time              AS media_time
//           FROM stories s
//           JOIN stories_media m ON m.story_id = s.story_id
//           JOIN users        u  ON u.user_id  = s.user_id
//          WHERE m.time >= (NOW() - INTERVAL 24 HOUR)
//          ORDER BY s.time DESC, m.media_id ASC
//         `
//       );
  
//       const groups = new Map();
  
//       for (const r of rows) {
//         const userIdKey = String(r.user_id);
  
//         // initialize group with username + avatar ONCE
//         if (!groups.has(userIdKey)) {
//           groups.set(userIdKey, {
//             userId: r.user_id,
//             username: r.username || '—',
//             avatar: (r.avatar), // normalize to /uploads/... if needed
//             stories: []
//           });
//         }
  
//         // push each media item with meta
//         groups.get(userIdKey).stories.push({
//           id:r.story_id,
//           url: (r.source),                     // normalize to /uploads/...
//           type: (r.source=='')?'text':(r.is_photo === '1' ? 'image' : 'video'),
//           // keep your meta (caption+stickers+music) for StoryViewer
//           meta: {
//             caption: r.text || undefined,
//             overlays: safeJSON(r.overlays) || [],
//             musicUrl: r.music_url || undefined,
//             musicVolume: (typeof r.music_volume === 'number') ? r.music_volume : undefined,
//           },
//           // optional extras if your UI needs:
//           mediaId: r.media_id,
//           createdAt: r.media_time
//         });
//       }
  
//       res.json(Array.from(groups.values()));
//     } catch (e) {
//       console.error('GET /stories error', e);
//       res.status(500).json({ error: 'Internal server error' });
//     }
//   });

//   // router.get("/", ensureAuth, async (req, res) => {
//   //   const limitPerUser = Math.max(1, Math.min(50, asInt(req.query.limitPerUser) || 20));
//   //   const includeAds = req.query.includeAds === "1";
  
//   //   // Optional time filter (last N hours)
//   //   const timeWhere = STORIES_EXPIRE_HOURS
//   //     ? "AND s.time >= (NOW() - INTERVAL ? HOUR)"
//   //     : "";
  
//   //   const params = [];
//   //   if (!includeAds) params.push("0"); // is_ads='0'
//   //   if (STORIES_EXPIRE_HOURS) params.push(STORIES_EXPIRE_HOURS);
  
//   //   try {
//   //     // Pull each story with its latest media record
//   //     const [rows] = await pool.query(
//   //       `
//   //       SELECT
//   //         s.story_id,
//   //         s.user_id,
//   //         u.user_name,
//   //         u.user_picture AS avatar,
//   //         s.time            AS story_time,
//   //         sm.media_id,
//   //         sm.source,
//   //         sm.is_photo,      -- '1' for image, '0' for video (per your schema)
//   //         sm.text           AS text_json,
//   //         sm.time           AS media_time
//   //       FROM stories s
//   //       JOIN users u ON u.user_id = s.user_id
//   //       LEFT JOIN (
//   //         SELECT sm1.*
//   //         FROM stories_media sm1
//   //         JOIN (
//   //           SELECT story_id, MAX(time) AS mt
//   //           FROM stories_media
//   //           GROUP BY story_id
//   //         ) latest ON latest.story_id = sm1.story_id AND latest.mt = sm1.time
//   //       ) sm ON sm.story_id = s.story_id
//   //       WHERE ${includeAds ? "1=1" : "s.is_ads = ?"}
//   //         ${timeWhere}
//   //       ORDER BY s.user_id ASC, s.time ASC
//   //       `,
//   //       params
//   //     );
  
//   //     // Group by user_id
//   //     const byUser = new Map();
//   //     for (const r of rows) {
//   //       const userId = Number(r.user_id);
//   //       if (!byUser.has(userId)) {
//   //         byUser.set(userId, {
//   //           userId,
//   //           username: r.user_name,
//   //           avatar: r.avatar || null,
//   //           stories: [],
//   //         });
//   //       }
  
//   //       // Derive item
//   //       let type = "text";
//   //       let url = "";
//   //       let meta = undefined;
  
//   //       const hasSource = r.source && String(r.source).trim().length > 0;
  
//   //       if (hasSource) {
//   //         // Distinguish photo vs video by is_photo ('1' | '0')
//   //         type = r.is_photo === "1" ? "image" : "video";
//   //         url = `/uploads/${r.source}`;
//   //       } else {
//   //         // text story: parse JSON payload from stories_media.text
//   //         try {
//   //           if (r.text_json) meta = JSON.parse(r.text_json);
//   //         } catch {
//   //           meta = undefined;
//   //         }
//   //         type = "text";
//   //       }
  
//   //       const item = {
//   //         id: Number(r.story_id),
//   //         type,
//   //         url,
//   //         meta,
//   //         created_at: (r.media_time || r.story_time || new Date()).toISOString?.() || r.media_time || r.story_time,
//   //       };
  
//   //       const arr = byUser.get(userId).stories;
//   //       arr.push(item);
  
//   //       // Trim to limit per user (keep latest N; current list is ASC so slice from end)
//   //       if (arr.length > limitPerUser) {
//   //         byUser.get(userId).stories = arr.slice(-limitPerUser);
//   //       }
//   //     }
  
//   //     // Emit grouped list (array)
//   //     const out = Array.from(byUser.values());
//   //     return res.json({ ok: true, items: out });
//   //   } catch (e) {
//   //     console.error("stories grouped fetch failed:", e);
//   //     return res.status(500).json({ ok: false, error: "Failed to fetch stories" });
//   //   }
//   // });

//   router.get("/:id/viewers", ensureAuth, async (req, res) => {
//     const storyId = (req.params.id);
//     if (!storyId) return res.status(400).json({ ok: false, error: "invalid id" });
//     try {
//       const limit = Math.min(100, parseInt(req.query.limit, 36));
//       const offset = parseInt(req.query.offset);
  
//       const [[cnt]] = await pool.query(
//         "SELECT COUNT(*) AS c FROM stories_views WHERE story_id=?",
//         [storyId]
//       );
  
//       const [rows] = await pool.query(
//         `SELECT v.viewer_user_id, u.user_name, u.user_picture
//            FROM stories_views v
//            LEFT JOIN users u ON u.user_id = v.viewer_user_id
//           WHERE v.story_id=?
//           ORDER BY v.id DESC
//           LIMIT ? OFFSET ?`,
//         [storyId, limit, offset]
//       );
  
//       res.json({ ok: true, count: Number(cnt.c || 0), items: rows });
//     } catch (e) {
//       console.error(e);
//       res.status(500).json({ ok: false, error: "Failed to fetch viewers" });
//     }
//   });

//   router.post("/:id/reply-intent", ensureAuth, async (req, res) => {
//     const storyId = (req.params.id);
//     const toUserId = (req.body?.toUserId);
//     if (!storyId || !toUserId) {
//       return res.status(400).json({ ok: false, error: "invalid payload" });
//     }
//     try {
//       await pool.query(
//         `INSERT INTO stories_replies_log (story_id, from_user_id, to_user_id, created_at)
//          VALUES (?,?,?, NOW())`,
//         [storyId, req.user.userId, toUserId]
//       );
//       res.json({ ok: true });
//     } catch (e) {
//       console.error(e);
//       res.status(500).json({ ok: false, error: "Failed to log reply" });
//     }
//   });

//   // POST /api/stories/:id/view
// // router.post("/:id/view", ensureAuth, async (req, res) => {
// //   const storyId = parseInt(req.params.id, 10);
// //   if (!storyId) {
// //     return res.status(400).json({ ok: false, error: "invalid story id" });
// //   }

// //   const viewerId = req.user.userId;

// //   try {
// //     // insert once per user/story, ignore duplicates
// //     await pool.query(
// //       `INSERT INTO stories_views (story_id, viewer_user_id, viewed_at)
// //        VALUES (?, ?, NOW())
// //        ON DUPLICATE KEY UPDATE viewed_at = VALUES(viewed_at)`,
// //       [storyId, viewerId]
// //     );

// //     // optionally: return updated count
// //     const [[countRow]] = await pool.query(
// //       "SELECT COUNT(*) AS cnt FROM stories_views WHERE story_id=?",
// //       [storyId]
// //     );

// //     res.json({ ok: true, count: countRow.cnt });
// //   } catch (err) {
// //     console.error("trackStoryView error:", err);
// //     res.status(500).json({ ok: false, error: "Failed to track view" });
// //   }
// // });

// router.post('/:id/view', ensureAuth, async (req, res) => {
//   const storyId = int(req.params.id);
//   const viewerId = int(req.user.userId);
//   if (!storyId || !viewerId) return res.status(400).json({ ok:false, error:'bad params' });

//   const conn = await pool.getConnection();
//   try {
//     await conn.beginTransaction();

//     // Optional: ensure not counting author viewing own story if you don't want that
//     // const [[s]] = await conn.query(`SELECT user_id FROM stories WHERE story_id=?`, [storyId]);
//     // if (!s) { await conn.rollback(); return res.status(404).json({ ok:false, error:'Story not found' }); }
//     // if (int(s.user_id) === viewerId) { await conn.commit(); return res.json({ ok:true, skipped:'author' }); }

//     // Atomic insert-only-if-story-exists. Also handles upsert for repeat views.
//     const [r] = await conn.query(
//       `
//       INSERT INTO stories_views (story_id, viewer_user_id, viewed_at)
//       SELECT s.story_id, ?, NOW()
//         FROM stories s
//        WHERE s.story_id = ?
//       ON DUPLICATE KEY UPDATE viewed_at = VALUES(viewed_at)
//       `,
//       [viewerId, storyId]
//     );

//     // If the SELECT found no story, affectedRows will be 0 (no insert/update)
//     if (r.affectedRows === 0) {
//       await conn.rollback();
//       return res.status(404).json({ ok:false, error:'Story not found' });
//     }

//     await conn.commit();
//     return res.json({ ok:true });
//   } catch (e) {
//     // If another path still triggers a FK error, convert to 404 (deleted race)
//     if (e && e.code === 'ER_NO_REFERENCED_ROW_2') {
//       try { await conn.rollback(); } catch {}
//       return res.status(404).json({ ok:false, error:'Story not found' });
//     }
//     try { await conn.rollback(); } catch {}
//     console.error('track view error:', e);
//     return res.status(500).json({ ok:false, error:'Failed to track view' });
//   } finally {
//     conn.release();
//   }
// });

// router.post("/text", ensureAuth, async (req, res) => {
//   const userId = req.user.userId;
//   const text = (req.body?.text || "").toString().trim();
//   const bg = (req.body?.bg || "#111111").toString();
//   const color = (req.body?.color || "#ffffff").toString();
//   const overlays = req.body?.overlays ?? null; // optional stickers/text overlays you may capture in composer
//   const music_url = req.body?.music_url ?? null;
//   const music_volume = typeof req.body?.music_volume === "number" ? req.body.music_volume : null;

//   if (!text) {
//     return res.status(400).json({ ok: false, error: "text required" });
//   }

//   const conn = await pool.getConnection();
//   try {
//     await conn.beginTransaction();

//     // 1) Create a story row (non-ads)
//     const [insStory] = await conn.query(
//       `INSERT INTO stories (user_id, is_ads, time)
//        VALUES (?, '0', NOW())`,
//       [userId]
//     );
//     const storyId = insStory.insertId;

//     // 2) Insert media row with text JSON (no file source)
//     const textJson = JSON.stringify({ text, bg, color, overlays: overlays || null });
//     await conn.query(
//       `INSERT INTO stories_media (story_id, source, is_photo, text, overlays, music_url, music_volume, time)
//        VALUES (?, '', '1', ?, ?, ?, ?, NOW())`,
//       [storyId, textJson, overlays ? JSON.stringify(overlays) : null, music_url, music_volume]
//     );

//     await conn.commit();

//     // 3) Response mirrors the structure the frontend expects
//     const item = {
//       id: storyId,
//       type: "text",
//       url: "",
//       meta: { text, bg, color, overlays: overlays || null, musicUrl: music_url, musicVolume: music_volume },
//       created_at: new Date().toISOString(),
//     };
//     return res.json({ ok: true, item });
//   } catch (e) {
//     try { await conn.rollback(); } catch {}
//     console.error("Create text story failed:", e);
//     return res.status(500).json({ ok: false, error: "Failed to create text story" });
//   } finally {
//     conn.release();
//   }
// });


// function int(v) {
//   const n = parseInt(v, 10);
//   return Number.isFinite(n) ? n : 0;
// }

// // keep deletions resilient if some optional tables don't exist
// async function safeExec(conn, sql, params = []) {
//   try {
//     await conn.query(sql, params);
//   } catch (e) {
//     // ignore "table doesn't exist"
//     if (e?.code !== "ER_NO_SUCH_TABLE") throw e;
//   }
// }

// // only allow deleting files inside /uploads by stripping to basename
// function safeUploadPath(uploadRel) {
//   if (!uploadRel) return null;
//   const base = path.basename(uploadRel);            // e.g., photo.jpg or 2025/09/photo.jpg -> photo.jpg
//   const parts = uploadRel.split(/[\\/]/).filter(Boolean);
//   // try to preserve subfolders like photos/2025/09 if present but stay inside uploads
//   const rel = parts.slice(parts.indexOf("uploads") + 1).join("/") || base;
//   return path.resolve(process.cwd(), "uploads", rel.includes("uploads/") ? rel.split("uploads/")[1] : rel);
// }

// router.delete("/:id", ensureAuth, async (req, res) => {
//   const storyId = int(req.params.id);
//   if (!storyId) return res.status(400).json({ ok: false, error: "invalid id" });

//   const conn = await pool.getConnection();
//   try {
//     await conn.beginTransaction();

//     // 1) Lock and verify owner
//     const [[story]] = await conn.query(
//       `SELECT story_id, user_id
//          FROM stories
//         WHERE story_id = ?
//         FOR UPDATE`,
//       [storyId]
//     );
//     if (!story) {
//       await conn.rollback();
//       return res.status(404).json({ ok: false, error: "Not found" });
//     }
//     if (int(story.user_id) !== int(req.user.userId)) {
//       await conn.rollback();
//       return res.status(403).json({ ok: false, error: "Forbidden" });
//     }

//     // 2) Load media rows to remove files (if any)
//     const [mediaRows] = await conn.query(
//       `SELECT media_id, source
//          FROM stories_media
//         WHERE story_id = ?`,
//       [storyId]
//     );

//     for (const m of mediaRows) {
//       const src = (m?.source || "").trim();
//       if (!src) continue;
//       // Accept absolute URLs or relative; only delete local files under /uploads
//       // Examples we see in DB: "photos/2025/09/XYZ.jpg"
//       let full = null;
//       if (/^https?:\/\//i.test(src)) {
//         // remote URL -> do not unlink disk
//         full = null;
//       } else {
//         // relative path
//         // ensure we don't escape uploads dir
//         const safeFull = path.resolve(process.cwd(), "uploads", src.replace(/^\/?uploads\//, ""));
//         // final guard: must still be inside uploads
//         const uploadsRoot = path.resolve(process.cwd(), "uploads");
//         if (safeFull.startsWith(uploadsRoot)) full = safeFull;
//       }
//       if (full) {
//         try { await fs.unlink(full); } catch (_) { /* ignore ENOENT etc. */ }
//       }
//     }

//     // 3) Delete media + auxiliary rows (ignore if some tables are absent)
//     await conn.query(`DELETE FROM stories_media WHERE story_id = ?`, [storyId]);
//     await safeExec(conn, `DELETE FROM stories_views WHERE story_id = ?`, [storyId]);
//     await safeExec(conn, `DELETE FROM stories_replies_log WHERE story_id = ?`, [storyId]);
//     await safeExec(conn, `DELETE FROM stories_reactions WHERE story_id = ?`, [storyId]);
  
//     // 4) Finally delete the story
//     await conn.query(`DELETE FROM stories WHERE story_id = ?`, [storyId]);

//     await conn.commit();
//     return res.json({ ok: true });
//   } catch (e) {
//     try { await conn.rollback(); } catch {}
//     console.error("delete story error:", e);
//     return res.status(500).json({ ok: false, error: "Failed to delete story" });
//   } finally {
//     conn.release();
//   }
// });


// module.exports = router;


// stories.js — DROP-IN
// Requires: express, multer, path, fs; and a mysql2/promise pool passed in.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const pool = require('../config/db'); // adjust to your db path
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'photos');

const STORIES_EXPIRE_HOURS = 24; // set to 0/false to disable time filter

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------- Cloudflare R2 setup ----------------
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

// filename helper to keep old “GADA_...” feel but unique
function r2StoryFilename(originalName) {
  const ext = path.extname(originalName || '.jpg').toLowerCase();
  const stamp = Date.now().toString(36);
  const rnd = crypto.randomBytes(6).toString('hex');
  return `GADA_${stamp}_${rnd}${ext}`;
}

// Multer in-memory storage for R2
const upload = multer({
  storage: multer.memoryStorage(),
});

// old diskStorage kept for reference (unused now)
// const storage = multer.diskStorage({...});

// -----------------------------------------------------

function formatMySQLDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function safeJSON(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

// ========= CREATE (file + meta) =========
router.post('/', ensureAuth, upload.single('file'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const meta = safeJSON(req.body?.meta) || {};
    const userId = req.user.userId; // adapt if your auth uses a different key
    const now = new Date();

    // ------ upload to R2 instead of local disk ------
    const nowYear = String(now.getFullYear());
    const nowMonth = String(now.getMonth() + 1).padStart(2, '0');
    const fileName = r2StoryFilename(req.file.originalname || 'story');
    // R2 key: photos/YYYY/MM/GADA_...
    const r2Key = `photos/${nowYear}/${nowMonth}/${fileName}`;

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'public-read', // or via bucket policy
      })
    );

    // This is what was previously stored as "rel" based on disk path:
    //   photos/2025/09/GADA_xxx.jpg
    const rel = r2Key.replace(/\\/g, '/');

    const isPhoto = req.file.mimetype.startsWith('image/') ? '1' : '0';
    const caption = (meta.caption || '').toString();
    const overlays = meta.overlays ? JSON.stringify(meta.overlays) : null;
    const musicUrl = meta.musicUrl || null;
    const musicVolume = typeof meta.musicVolume === 'number' ? meta.musicVolume : 0.8;

    await conn.beginTransaction();

    // Parent story row
    const [storyR] = await conn.execute(
      'INSERT INTO `stories` (`user_id`, `is_ads`, `time`) VALUES (?, ?, NOW())',
      [userId, '0']
    );
    const storyId = storyR.insertId;

    // Media row including caption (text) + new fields
    await conn.execute(
      `INSERT INTO stories_media
         (story_id, source, is_photo, text, overlays, music_url, music_volume, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [storyId, rel, isPhoto, caption, overlays, musicUrl, musicVolume]
    );

    await conn.commit();

    // Respond with a shape the frontend expects
    res.status(201).json({
      storyId,
      userId,
      // prefix with /uploads to keep old FE behaviour `${API_BASE_URL}/uploads/${rel}`
      url: '/' + rel,
      type: isPhoto === '1' ? 'image' : 'video',
      meta: {
        caption: caption || undefined,
        overlays: meta.overlays || [],
        musicUrl: musicUrl || undefined,
        musicVolume,
      },
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error('POST /stories error', e);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

// ========= LIST stories (map DB → viewer-friendly shape) =========
router.get('/', ensureAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
        SELECT s.story_id,
               s.user_id,
               s.time              AS story_time,
               u.user_name         AS username,
               u.user_picture      AS avatar,
               m.media_id,
               m.source,
               m.is_photo,
               m.text,             -- caption
               m.overlays,
               m.music_url,
               m.music_volume,
               m.time              AS media_time
          FROM stories s
          JOIN stories_media m ON m.story_id = s.story_id
          JOIN users        u  ON u.user_id  = s.user_id
         WHERE m.time >= (NOW() - INTERVAL 24 HOUR)
         ORDER BY s.time DESC, m.media_id ASC
        `
    );

    const groups = new Map();

    for (const r of rows) {
      const userIdKey = String(r.user_id);

      // initialize group with username + avatar ONCE
      if (!groups.has(userIdKey)) {
        groups.set(userIdKey, {
          userId: r.user_id,
          username: r.username || '—',
          avatar: r.avatar, // normalize to /uploads/... if needed
          stories: [],
        });
      }

      groups.get(userIdKey).stories.push({
        id: r.story_id,
        url: r.source, // already something like photos/....; FE prefixes /uploads
        type: r.source == '' ? 'text' : r.is_photo === '1' ? 'image' : 'video',
        meta: {
          caption: r.text || undefined,
          overlays: safeJSON(r.overlays) || [],
          musicUrl: r.music_url || undefined,
          musicVolume:
            typeof r.music_volume === 'number' ? r.music_volume : undefined,
        },
        mediaId: r.media_id,
        createdAt: r.media_time,
      });
    }

    res.json(Array.from(groups.values()));
  } catch (e) {
    console.error('GET /stories error', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// router.get("/", ensureAuth, async (req, res) => { ... old grouped endpoint ... });

router.get('/:id/viewers', ensureAuth, async (req, res) => {
  const storyId = req.params.id;
  if (!storyId)
    return res.status(400).json({ ok: false, error: 'invalid id' });
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 36));
    const offset = parseInt(req.query.offset);

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS c FROM stories_views WHERE story_id=?',
      [storyId]
    );

    const [rows] = await pool.query(
      `SELECT v.viewer_user_id, u.user_name, u.user_picture
           FROM stories_views v
           LEFT JOIN users u ON u.user_id = v.viewer_user_id
          WHERE v.story_id=?
          ORDER BY v.id DESC
          LIMIT ? OFFSET ?`,
      [storyId, limit, offset]
    );

    res.json({ ok: true, count: Number(cnt.c || 0), items: rows });
  } catch (e) {
    console.error(e);
    res
      .status(500)
      .json({ ok: false, error: 'Failed to fetch viewers' });
  }
});

router.post('/:id/reply-intent', ensureAuth, async (req, res) => {
  const storyId = req.params.id;
  const toUserId = req.body?.toUserId;
  if (!storyId || !toUserId) {
    return res
      .status(400)
      .json({ ok: false, error: 'invalid payload' });
  }
  try {
    await pool.query(
      `INSERT INTO stories_replies_log (story_id, from_user_id, to_user_id, created_at)
         VALUES (?,?,?, NOW())`,
      [storyId, req.user.userId, toUserId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res
      .status(500)
      .json({ ok: false, error: 'Failed to log reply' });
  }
});

// POST /api/stories/:id/view (new implementation)
router.post('/:id/view', ensureAuth, async (req, res) => {
  const storyId = int(req.params.id);
  const viewerId = int(req.user.userId);
  if (!storyId || !viewerId)
    return res.status(400).json({ ok: false, error: 'bad params' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      `
      INSERT INTO stories_views (story_id, viewer_user_id, viewed_at)
      SELECT s.story_id, ?, NOW()
        FROM stories s
       WHERE s.story_id = ?
      ON DUPLICATE KEY UPDATE viewed_at = VALUES(viewed_at)
      `,
      [viewerId, storyId]
    );

    if (r.affectedRows === 0) {
      await conn.rollback();
      return res
        .status(404)
        .json({ ok: false, error: 'Story not found' });
    }

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 'ER_NO_REFERENCED_ROW_2') {
      try {
        await conn.rollback();
      } catch {}
      return res
        .status(404)
        .json({ ok: false, error: 'Story not found' });
    }
    try {
      await conn.rollback();
    } catch {}
    console.error('track view error:', e);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to track view' });
  } finally {
    conn.release();
  }
});

router.post('/text', ensureAuth, async (req, res) => {
  const userId = req.user.userId;
  const text = (req.body?.text || '').toString().trim();
  const bg = (req.body?.bg || '#111111').toString();
  const color = (req.body?.color || '#ffffff').toString();
  const overlays = req.body?.overlays ?? null;
  const music_url = req.body?.music_url ?? null;
  const music_volume =
    typeof req.body?.music_volume === 'number'
      ? req.body.music_volume
      : null;

  if (!text) {
    return res
      .status(400)
      .json({ ok: false, error: 'text required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [insStory] = await conn.query(
      `INSERT INTO stories (user_id, is_ads, time)
       VALUES (?, '0', NOW())`,
      [userId]
    );
    const storyId = insStory.insertId;

    const textJson = JSON.stringify({
      text,
      bg,
      color,
      overlays: overlays || null,
    });
    await conn.query(
      `INSERT INTO stories_media (story_id, source, is_photo, text, overlays, music_url, music_volume, time)
       VALUES (?, '', '1', ?, ?, ?, ?, NOW())`,
      [
        storyId,
        textJson,
        overlays ? JSON.stringify(overlays) : null,
        music_url,
        music_volume,
      ]
    );

    await conn.commit();

    const item = {
      id: storyId,
      type: 'text',
      url: '',
      meta: {
        text,
        bg,
        color,
        overlays: overlays || null,
        musicUrl: music_url,
        musicVolume: music_volume,
      },
      created_at: new Date().toISOString(),
    };
    return res.json({ ok: true, item });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error('Create text story failed:', e);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to create text story' });
  } finally {
    conn.release();
  }
});

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// keep deletions resilient if some optional tables don't exist
async function safeExec(conn, sql, params = []) {
  try {
    await conn.query(sql, params);
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

// only allow deleting files inside /uploads by stripping to basename
function safeUploadPath(uploadRel) {
  if (!uploadRel) return null;
  const base = path.basename(uploadRel);
  const parts = uploadRel.split(/[\\/]/).filter(Boolean);
  const rel =
    parts.slice(parts.indexOf('uploads') + 1).join('/') || base;
  return path.resolve(
    process.cwd(),
    'uploads',
    rel.includes('uploads/')
      ? rel.split('uploads/')[1]
      : rel
  );
}

// ========= DELETE story (now also removes from R2) =========
router.delete('/:id', ensureAuth, async (req, res) => {
  const storyId = int(req.params.id);
  if (!storyId)
    return res
      .status(400)
      .json({ ok: false, error: 'invalid id' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[story]] = await conn.query(
      `SELECT story_id, user_id
         FROM stories
        WHERE story_id = ?
        FOR UPDATE`,
      [storyId]
    );
    if (!story) {
      await conn.rollback();
      return res
        .status(404)
        .json({ ok: false, error: 'Not found' });
    }
    if (int(story.user_id) !== int(req.user.userId)) {
      await conn.rollback();
      return res
        .status(403)
        .json({ ok: false, error: 'Forbidden' });
    }

    const [mediaRows] = await conn.query(
      `SELECT media_id, source
         FROM stories_media
        WHERE story_id = ?`,
      [storyId]
    );

    // delete from R2 if source looks like photos/...
    for (const m of mediaRows) {
      const src = (m?.source || '').trim();
      if (!src) continue;

      if (!/^https?:\/\//i.test(src)) {
        // stored as relative like photos/2025/09/XYZ.jpg
        const r2Key = src.replace(/^\/+/, '');
        try {
          await r2Client.send(
            new DeleteObjectCommand({
              Bucket: R2_BUCKET,
              Key: r2Key,
            })
          );
        } catch (e) {
          console.error('R2 delete error (story media):', e?.message || e);
        }
      }
    }

    await conn.query(
      `DELETE FROM stories_media WHERE story_id = ?`,
      [storyId]
    );
    await safeExec(
      conn,
      `DELETE FROM stories_views WHERE story_id = ?`,
      [storyId]
    );
    await safeExec(
      conn,
      `DELETE FROM stories_replies_log WHERE story_id = ?`,
      [storyId]
    );
    await safeExec(
      conn,
      `DELETE FROM stories_reactions WHERE story_id = ?`,
      [storyId]
    );

    await conn.query(
      `DELETE FROM stories WHERE story_id = ?`,
      [storyId]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error('delete story error:', e);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to delete story' });
  } finally {
    conn.release();
  }
});

module.exports = router;
