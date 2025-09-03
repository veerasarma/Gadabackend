// stories.js — DROP-IN
// Requires: express, multer, path, fs; and a mysql2/promise pool passed in.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const  pool  = require('../config/db'); // adjust to your db path
const {ensureAuth} = require('../middlewares/auth')

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'photos');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const folder = path.join(UPLOAD_ROOT, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg');
    cb(null, `GADA_${Math.random().toString(16).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

function formatMySQLDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

  // CREATE (file + meta)
  router.post('/', ensureAuth, upload.single('file'), async (req, res) => {
    const conn = await pool.getConnection();
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      const meta = safeJSON(req.body?.meta) || {};
      const userId = req.user.userId; // adapt if your auth uses a different key
      const now = new Date();

      // relative path like photos/2025/09/GADA_xxx.jpg
      const photosIdx = req.file.path.lastIndexOf(path.sep + 'photos' + path.sep);
      const rel = photosIdx >= 0
        ? req.file.path.substring(photosIdx + 1).replace(/\\/g, '/')
        : 'photos/' + path.basename(req.file.path);

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
        url: '/' + rel, // your frontend prefixes with `${API_BASE_URL}/uploads`
        type: isPhoto === '1' ? 'image' : 'video',
        meta: {
          caption: caption || undefined,
          overlays: meta.overlays || [],
          musicUrl: musicUrl || undefined,
          musicVolume
        }
      });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('POST /stories error', e);
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      conn.release();
    }
  });

  // LIST stories (map DB → viewer-friendly shape)
  router.get('/', ensureAuth, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT s.story_id, s.user_id, s.time AS story_time,
                m.media_id, m.source, m.is_photo, m.text,
                m.overlays, m.music_url, m.music_volume, m.time AS media_time
         FROM stories s
         JOIN stories_media m ON m.story_id = s.story_id
         ORDER BY s.time DESC, m.media_id ASC`
      );

      const byUser = new Map();
      for (const r of rows) {
        if (!byUser.has(r.user_id)) {
          byUser.set(r.user_id, {
            userId: r.user_id,
            username: '',     // hydrate if you join users table
            avatar: '',
            stories: []
          });
        }
        byUser.get(r.user_id).stories.push({
          url: '/' + r.source,
          type: r.is_photo === '1' ? 'image' : 'video',
          meta: {
            caption: r.text || undefined,
            overlays: safeJSON(r.overlays) || [],
            musicUrl: r.music_url || undefined,
            musicVolume: typeof r.music_volume === 'number' ? r.music_volume : undefined
          }
        });
      }
      res.json(Array.from(byUser.values()));
    } catch (e) {
      console.error('GET /stories error', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });



module.exports = router;
