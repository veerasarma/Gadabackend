// routes/users.js
const express       = require('express');
const { query,param, validationResult } = require('express-validator');
const pool          = require('../config/db');
const router        = express.Router();
const { encodeId, decodeId } = require('../utils/idCipher');
const multer        = require('multer');
const path          = require('path');
const { ensureAuth } = require('../middlewares/auth');


const storage = multer.diskStorage({
  destination: path.join(__dirname, '../uploads/profile'),
  filename: (_, file, cb) => {
    const safe = file.originalname
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_\.-]/g, '');
    cb(null, `avatar_${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    const ok = /\.(jpe?g|png|gif)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  },
  limits: { fileSize: 5 * 1024 * 1024 }  // 5MB
});

function sanitizeQ(q='') {
  return q.trim().replace(/\s+/g, ' ');
}

// 2) PUT /api/users/:hash/avatar
router.put(
  '/:hash/avatar',
  ensureAuth,
  upload.single('avatar'),
  async (req, res) => {
    // 3) Decode and auth check
    let userId;
    try {
      userId = decodeId(req.params.hash);
    } catch {
      return res.status(404).json({ error: 'Invalid user' });
    }
  
    if (req.user.userId != userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // 4) Save new path
    const avatarPath = `/uploads/profile/${path.basename(req.file.path)}`;
    try {
      await pool.query(
        'UPDATE users SET user_picture = ? WHERE user_id = ?',
        [avatarPath, userId]
      );
      // 5) Return new URL (opaque ID if using hashids)
      res.json({
        avatarUrl: avatarPath
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'DB update failed' });
    }
  }
);

router.put(
  '/:hash/cover',
  ensureAuth,
  upload.single('avatar'),
  async (req, res) => {
    // 3) Decode and auth check
    let userId;
    try {
      userId = decodeId(req.params.hash);
    } catch {
      return res.status(404).json({ error: 'Invalid user' });
    }
  
    if (req.user.userId != userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // 4) Save new path
    const avatarPath = `/uploads/profile/${path.basename(req.file.path)}`;
    try {
      await pool.query(
        'UPDATE users SET user_cover = ? WHERE user_id = ?',
        [avatarPath, userId]
      );
      // 5) Return new URL (opaque ID if using hashids)
      res.json({
        avatarUrl: avatarPath
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'DB update failed' });
    }
  }
);

router.get(
  '/search',
  ensureAuth,
  query('q').isString().trim().isLength({ min: 1, max: 50 }),
  async (req, res) => {
    const errs = validationResult(req);
    console.log(errs,'errserrs')
    if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

    const me = req.user.userId;
    const q  = `%${req.query.q}%`;
    try {
      const [rows] = await pool.query(
        `SELECT u.user_id, u.user_name, u.user_picture AS profileImage
         FROM users As u
         WHERE u.user_name LIKE ?
           AND u.user_id <> ? 
           AND u.user_approved = '1'
           AND u.user_id NOT IN (                    -- not already friends
            SELECT id 
            FROM friends 
            WHERE user_id = ?
          )
         ORDER BY u.user_name
         LIMIT 20`,
        [q, me, me]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

router.get(
  '/fetchbalance', ensureAuth,
  async (req, res) => {
    let userId;
    userId = req.user.userId
    try {
      // 2) Fetch user
      const [rows] = await pool.query(
        `SELECT 
         user_wallet_balance
         FROM users
         WHERE user_id = ?`,
        [userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      // 3) Return
      res.json(rows[0].user_wallet_balance);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error fetching profile' });
    }
  }
);

router.get(
  '/fetchuserbalance', ensureAuth,
  async (req, res) => {
    let userId;
    userId = req.user.userId
    try {
      // 2) Fetch user
      const [rows] = await pool.query(
        `SELECT 
         user_wallet_balance,user_points
         FROM users
         WHERE user_id = ?`,
        [userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      // 3) Return
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error fetching profile' });
    }
  }
);

router.get('/suggest', async (req, res) => {
  try {
    console.log('dfsdfsdf')
    const raw = String(req.query.q || '');
    const q = sanitizeQ(raw);
    if (q.length < 2) return res.json([]);

    // Heuristics
    
    const plain =  q;
    // const like = makeLike(plain.toLowerCase());

    const qLower = plain.toLowerCase();

    // We attempt FULLTEXT where possible; otherwise LIKE
    // USERS
   // USERS (prefix match on each field)
const [userRows] = await pool.query(
    `
    SELECT u.user_id   AS id,
           u.user_name AS username,
           CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS fullName,
           u.user_picture AS avatar
      FROM users u
     WHERE (LOWER(u.user_name)      LIKE CONCAT(?, '%')
         OR  LOWER(u.user_firstname) LIKE CONCAT(?, '%')
         OR  LOWER(u.user_lastname)  LIKE CONCAT(?, '%'))
     ORDER BY u.user_id DESC
     LIMIT 5
    `,
    [qLower, qLower, qLower]
  );
  res.json(userRows);
}
catch(e){

}
});

// GET /api/users/:id
router.get(
  '/:hash',
  async (req, res) => {
    let userId;
    userId = decodeId(req.params.hash);
    
    try {
      // 2) Fetch user
      const [rows] = await pool.query(
        `SELECT 
           user_id, user_name As username, user_biography, user_picture AS profileImage,user_cover AS coverImage,user_registered AS createdAt
         FROM users
         WHERE user_id = ?`,
        [userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      // 3) Return
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error fetching profile' });
    }
  }
);







module.exports = router;
