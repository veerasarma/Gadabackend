// server/routes/settings.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const pool = require('../config/db');
const { ensureAuth } = require('../middlewares/auth');
const bcrypt = require('bcrypt');

// Util: ensure row exists
async function ensureRows(userId) {
  await pool.query(
    'INSERT IGNORE INTO user_privacy_settings (user_id) VALUES (?)',
    [userId]
  );
  await pool.query(
    'INSERT IGNORE INTO user_notification_settings (user_id) VALUES (?)',
    [userId]
  );
}

/* ---------------------------------- GENERAL ---------------------------------- */
// GET /api/settings/profile
router.get('/profile', ensureAuth, async (req, res, next) => {
  try {
    const uid = req.user.userId;
    const [[row]] = await pool.query(
      `SELECT user_id AS id, user_name AS username, user_email,
              user_phone AS phone, user_birthdate AS dateOfBirth, user_gender AS gender,
              user_current_city AS city, user_country AS country, user_language AS language, user_website AS website, user_work_title AS work, user_privacy_education AS education
         FROM users WHERE user_id=?`,
      [uid]
    );
    res.json(row);
  } catch (e) { next(e); }
});

// PUT /api/settings/profile
router.put(
  '/profile',
  ensureAuth,
  body('phone').optional().isString().isLength({ max: 32 }),
  body('dateOfBirth').optional().isISO8601(),
  body('gender').optional().isIn(['male','female','non_binary','prefer_not']),
  body('city').optional().isString().isLength({ max: 120 }),
  body('country').optional().isString().isLength({ max: 120 }),
  body('timezone').optional().isString().isLength({ max: 64 }),
  body('language').optional().isString().isLength({ max: 8 }),
  body('website').optional().isURL().isLength({ max: 255 }),
  body('work').optional().isString().isLength({ max: 255 }),
  body('education').optional().isString().isLength({ max: 255 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const uid = req.user.userId;
      console.log(uid,'uiduid')
      const {
        phone, dateOfBirth, gender, city, country,
        timezone, language, website, work, education
      } = req.body;
      console.log(req.body,'req.bodyreq.bodyreq.body')
      let update = await pool.query(
        `UPDATE users SET
           user_phone=?, user_birthdate=?, user_gender=?,
           user_current_city=?, user_country=?, user_language=?,
           user_website=?, user_work_title=?, user_privacy_education=?
         WHERE user_id=?`,
        [phone, dateOfBirth , gender ,
         city , country , language ?? 'en',
         website ?? null, work ?? null, education ?? null, uid]
      );
      console.log(update,'updateupdateupdate',phone,education,dateOfBirth)
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/* ---------------------------------- PRIVACY ---------------------------------- */
// GET
router.get('/privacy', ensureAuth, async (req, res, next) => {
  try {
    const uid = req.user.userId;
    await ensureRows(uid);
    const [[row]] = await pool.query(
      `SELECT profile_visibility AS profileVisibility,
              friend_request_policy AS friendRequestPolicy,
              lookup_email AS lookupEmail,
              lookup_phone AS lookupPhone,
              show_online AS showOnline,
              tag_review AS tagReview
         FROM user_privacy_settings WHERE user_id=?`, [uid]);
    res.json(row);
  } catch (e) { next(e); }
});

// PUT
router.put(
  '/privacy',
  ensureAuth,
  body('profileVisibility').isIn(['everyone','friends','only_me']),
  body('friendRequestPolicy').isIn(['everyone','friends_of_friends']),
  body('lookupEmail').isIn(['everyone','friends','only_me']),
  body('lookupPhone').isIn(['everyone','friends','only_me']),
  body('showOnline').isBoolean(),
  body('tagReview').isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const uid = req.user.userId;
      await ensureRows(uid);
      const { profileVisibility, friendRequestPolicy, lookupEmail, lookupPhone, showOnline, tagReview } = req.body;
      await pool.query(
        `UPDATE user_privacy_settings SET
           profile_visibility=?, friend_request_policy=?,
           lookup_email=?, lookup_phone=?, show_online=?, tag_review=?
         WHERE user_id=?`,
        [profileVisibility, friendRequestPolicy, lookupEmail, lookupPhone, showOnline ? 1 : 0, tagReview ? 1 : 0, uid]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/* ------------------------------- NOTIFICATIONS ------------------------------- */
// GET
router.get('/notifications', ensureAuth, async (req, res, next) => {
  try {
    const uid = req.user.userId;
    await ensureRows(uid);
    const [[row]] = await pool.query(
      `SELECT inapp_likes AS inappLikes,
              inapp_comments AS inappComments,
              inapp_mentions AS inappMentions,
              inapp_friend_requests AS inappFriendRequests,
              inapp_group_activity AS inappGroupActivity,
              inapp_payments AS inappPayments,
              email_digest AS emailDigest,
              email_security AS emailSecurity
         FROM user_notification_settings WHERE user_id=?`, [uid]);
    res.json(row);
  } catch (e) { next(e); }
});

// PUT
router.put(
  '/notifications',
  ensureAuth,
  // all boolean flags optional
  body('inappLikes').optional().isBoolean(),
  body('inappComments').optional().isBoolean(),
  body('inappMentions').optional().isBoolean(),
  body('inappFriendRequests').optional().isBoolean(),
  body('inappGroupActivity').optional().isBoolean(),
  body('inappPayments').optional().isBoolean(),
  body('emailDigest').optional().isBoolean(),
  body('emailSecurity').optional().isBoolean(),
  async (req, res, next) => {
    try {
      const uid = req.user.userId;
      await ensureRows(uid);
      const fields = [
        'inappLikes','inappComments','inappMentions','inappFriendRequests',
        'inappGroupActivity','inappPayments','emailDigest','emailSecurity'
      ];
      const updates = [];
      const params = [];
      for (const f of fields) {
        if (f in req.body) {
          updates.push(`${toColumn(f)}=?`);
          params.push(req.body[f] ? 1 : 0);
        }
      }
      if (!updates.length) return res.json({ ok: true });
      params.push(uid);
      await pool.query(
        `UPDATE user_notification_settings SET ${updates.join(', ')} WHERE user_id=?`,
        params
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

function toColumn(jsName) {
  return jsName.replace(/[A-Z]/g, m => '_' + m.toLowerCase()); // camelCase -> snake_case columns
}

/* ------------------------- SECURITY: PASSWORD + SESSIONS ------------------------- */
// Change password
router.put(
  '/security/password',
  ensureAuth,
  body('currentPassword').isString().isLength({ min: 6 }),
  body('newPassword').isString().isLength({ min: 8 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      console.log(errors,'errors')
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const uid = req.user.userId;
      const { currentPassword, newPassword } = req.body;

      // fetch hash
      const [[user]] = await pool.query('SELECT user_password FROM users WHERE user_id=?', [uid]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const ok = await bcrypt.compare(currentPassword, user.user_password);
      if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET user_password=? WHERE user_id=?', [newHash, uid]);

      // OPTIONAL: revoke other sessions (keep current)
      await pool.query('DELETE FROM user_sessions WHERE user_id=? AND id<>?', [uid, req.sessionId ?? '']);

      res.json({ ok: true });
    } catch (e) { next(e); console.log(e,';ee') }
  }
);

// Sessions: list & revoke
router.get('/security/sessions', ensureAuth, async (req, res, next) => {
    try {
      const uid = req.user.userId;
      const [rows] = await pool.query(
        `SELECT id, user_agent AS userAgent, ip,
                created_at AS createdAt, last_seen AS lastSeen
           FROM user_sessions
          WHERE user_id = ?
       ORDER BY (last_seen IS NULL) ASC, last_seen DESC, created_at DESC`,
        [uid]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

router.delete('/security/sessions/:id', ensureAuth, async (req, res, next) => {
  try {
    const uid = req.user.userId;
    const sid = req.params.id;
    await pool.query('DELETE FROM user_sessions WHERE id=? AND user_id=?', [sid, uid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
