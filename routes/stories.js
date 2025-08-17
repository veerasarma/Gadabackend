// routes/stories.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db'); // mysql2/promise pool
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ensureAuth } = require('../middlewares/auth'); // your existing auth middleware

// ---- storage for photos/videos/YYYY/MM ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const bucket = file.mimetype.startsWith('video/') ? 'videos' : 'photos';
    const dir = path.join(process.cwd(), 'uploads', bucket, year, month);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    cb(null, `${base}${ext}`);
  },
});
const upload = multer({ storage });

// helper to convert DB relative path "photos/2025/08/..."
// into absolute url "http://host/uploads/photos/2025/08/..."
function absUrl(req, relPath) {
  const cleaned = String(relPath || '').replace(/^\/+/, ''); // ensure no leading slash
  return `/uploads/${cleaned}`;
}

/**
 * GET /api/stories
 * Return active stories in last 24h grouped by user
 * Shape matches storyService.ts: Story[]
 */
router.get('/', ensureAuth, async (req, res) => {
  try {
    // Pull all story media in last 24h with user info
    const [rows] = await pool.query(
      `
      SELECT s.story_id,
             s.user_id,
             u.user_name        AS username,
             u.user_picture     AS avatar,
             m.media_id,
             m.source,
             m.is_photo,
             m.time
        FROM stories s
        JOIN stories_media m ON m.story_id = s.story_id
        JOIN users u        ON u.user_id   = s.user_id
       WHERE m.time >= (NOW() - INTERVAL 24 HOUR)
       ORDER BY s.user_id ASC, m.time ASC
      `
    );

    // Group by user
    const groups = new Map();
    for (const r of rows) {
      const userId = String(r.user_id);
      if (!groups.has(userId)) {
        groups.set(userId, {
          id: String(r.story_id),        // any story id in the group is fine
          userId,
          username: r.username || '—',
          avatar: r.avatar ? (req, r.avatar) : '', // if avatars are stored in uploads too
          stories: [],
        });
      }
      groups.get(userId).stories.push({
        id: String(r.media_id),
        url: (req, r.source),                // convert 'photos/...'
        type: r.is_photo === '1' ? 'image' : 'video',
        createdAt: r.time,
      });
    }

    res.json(Array.from(groups.values()));
  } catch (e) {
    console.error('[GET /api/stories] ', e);
    res.status(500).json({ error: 'Failed to load stories' });
  }
});

/**
 * POST /api/stories
 * field name: "media" (single file)
 * Creates a story row and 1 media item.
 */
router.post('/', ensureAuth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

    // Determine relative DB path like "photos/YYYY/MM/filename"
    const rel = path
      .relative(
        path.join(process.cwd(), 'uploads'),
        req.file.path
      )
      .replace(/\\/g, '/'); // windows-safe

    // 1) create story group for this user
    const [storyRes] = await pool.query(
      `INSERT INTO stories (user_id, is_ads, time) VALUES (?, '0', NOW())`,
      [req.user.userId]
    );
    const storyId = storyRes.insertId;

    // 2) create media
    const isPhoto = req.file.mimetype.startsWith('video/') ? '0' : '1';
    const [mediaRes] = await pool.query(
      `INSERT INTO stories_media (story_id, source, is_photo, text, time)
       VALUES (?, ?, ?, '', NOW())`,
      [storyId, rel, isPhoto]
    );

    const out = {
      id: String(storyId),
      url: absUrl(req, rel),
      type: isPhoto === '1' ? 'image' : 'video',
      mediaId: String(mediaRes.insertId),
    };
    res.status(201).json(out);
  } catch (e) {
    console.error('[POST /api/stories] ', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
