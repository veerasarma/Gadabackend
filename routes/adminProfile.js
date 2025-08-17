// server/routes/adminProfile.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/db'); // your mysql2/promise pool
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();

// All admin profile endpoints require admin
router.use(ensureAuth, requireRole('admin'));

/** ---------- Multer for avatar upload ---------- */
const avatarDir = path.join(__dirname, '..', 'uploads', 'profile');
fs.mkdirSync(avatarDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `admin_avatar_${Date.now()}_${safe}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.mimetype)) {
    return cb(new Error('Only image files are allowed'), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/** ---------- GET /api/admin/profile/me ---------- */
router.get('/me', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const [[u]] = await pool.query(
      `SELECT 
         user_id      AS id,
         user_name    AS username,
         user_email As email,
         user_firstname   AS firstname,
         user_lastname    AS lastname,
         user_profileImage AS profileImage,
         user_bio,
         timezone,
         createdAt
       FROM users
       WHERE user_id = ?`,
      [userId]
    );
    if (!u) return res.status(404).json({ error: 'Admin user not found' });
    res.json(u);
  } catch (e) { next(e); }
});

/** ---------- PUT /api/admin/profile (update info) ---------- */
router.put(
  '/',
  [
    body('username').optional().isLength({ min: 3, max: 32 }).trim(),
    body('firstname').optional().isLength({ max: 50 }).trim(),
    body('lastname').optional().isLength({ max: 50 }).trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('bio').optional().isLength({ max: 280 }).trim(),
    body('timezone').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = req.user.userId;
      const { username, firstname, lastname, email, bio, timezone } = req.body || {};

      // Uniqueness check on username/email (excluding self)
      if (username) {
        const [[exists]] = await pool.query(
          `SELECT user_id FROM users WHERE user_name = ? AND user_id <> ?`,
          [username, userId]
        );
        if (exists) return res.status(409).json({ error: 'Username already taken' });
      }
      if (email) {
        const [[existsE]] = await pool.query(
          `SELECT user_id FROM users WHERE email = ? AND user_id <> ?`,
          [email, userId]
        );
        if (existsE) return res.status(409).json({ error: 'Email already in use' });
      }

      // Build dynamic SET clause
      const fields = [];
      const vals = [];
      if (username != null) { fields.push('user_name = ?'); vals.push(username); }
      if (firstname != null) { fields.push('first_name = ?'); vals.push(firstname); }
      if (lastname != null) { fields.push('last_name = ?'); vals.push(lastname); }
      if (email != null) { fields.push('email = ?'); vals.push(email); }
      if (bio != null) { fields.push('bio = ?'); vals.push(bio); }
      if (timezone != null) { fields.push('timezone = ?'); vals.push(timezone); }

      if (!fields.length) return res.json({ ok: true }); // nothing to update

      vals.push(userId);
      await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`, vals);

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/** ---------- PUT /api/admin/profile/password ---------- */
router.put(
  '/password',
  [
    body('oldPassword').isString().isLength({ min: 6 }),
    body('newPassword').isString().isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const userId = req.user.userId;
      const { oldPassword, newPassword } = req.body;

      const [[u]] = await pool.query(
        `SELECT user_password AS hash FROM users WHERE user_id = ?`,
        [userId]
      );
      if (!u) return res.status(404).json({ error: 'Admin user not found' });

      const ok = await bcrypt.compare(oldPassword, u.hash || '');
      if (!ok) return res.status(400).json({ error: 'Old password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 12);
      await pool.query(`UPDATE users SET user_password = ? WHERE user_id = ?`, [newHash, userId]);

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/** ---------- PUT /api/admin/profile/avatar ---------- */
router.put('/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const userId = req.user.userId;

    const url = `/uploads/profile/${path.basename(req.file.path)}`;
    await pool.query(`UPDATE users SET profile_image = ? WHERE user_id = ?`, [url, userId]);

    res.json({ avatarUrl: url });
  } catch (e) { next(e); }
});

/** ---------- (Optional) sessions listing & revoke ---------- */
router.get('/sessions', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const [rows] = await pool.query(
      `SELECT 
         id, user_agent AS userAgent, ip, created_at AS createdAt, last_seen AS lastSeen
       FROM user_sessions
       WHERE user_id = ?
       ORDER BY COALESCE(last_seen, created_at) DESC, created_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.delete('/sessions/:id',
  [param('id').isString()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const userId = req.user.userId;
      const { id } = req.params;
      await pool.query(`DELETE FROM user_sessions WHERE id = ? AND user_id = ?`, [id, userId]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
