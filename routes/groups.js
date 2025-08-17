// backend/routes/groups.js
const express = require('express');
const { query, param, body, validationResult } = require('express-validator');
const db = require('../config/db'); // your mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

// GET /api/groups?tab=discover|joined|mine&q=&limit=12&cursor=0
router.get(
  '/',
  ensureAuth,
  [
    query('tab').optional().isIn(['discover', 'joined', 'mine']),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().toInt().isInt({ min: 1, max: 50 }),
    query('cursor').optional().toInt().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id; // from ensureAuth
    const {
      tab = 'discover',
      q = '',
      limit = 12,
      cursor = 0,
    } = req.query;

    const like = `%${q}%`;
    const pageParams = [Number(cursor), Number(limit) + 1];

    try {
      let rows;
      if (tab === 'joined') {
        // joined by current user & approved
        const [r] = await db.query(
          `
          SELECT g.group_id, g.group_name, g.group_title, g.group_description,
                 g.group_picture, g.group_members, g.group_privacy, g.group_date,
                 '1' AS joined, '1' AS approved
            FROM groups_members m
            JOIN groups g ON g.group_id = m.group_id
           WHERE m.user_id = ? AND m.approved = '1'
           ORDER BY g.group_date DESC
           LIMIT ?, ?
        `,
          [userId, ...pageParams]
        );
        rows = r;
      } else if (tab === 'mine') {
        // groups I admin
        const [r] = await db.query(
          `
          SELECT g.group_id, g.group_name, g.group_title, g.group_description,
                 g.group_picture, g.group_members, g.group_privacy, g.group_date,
                 CASE WHEN m.user_id IS NULL THEN '0' ELSE '1' END AS joined,
                 m.approved
            FROM groups g
            LEFT JOIN groups_members m
              ON m.group_id = g.group_id AND m.user_id = ?
           WHERE g.group_admin = ?
             AND (? = '' OR g.group_name LIKE ? OR g.group_title LIKE ?)
           ORDER BY g.group_date DESC
           LIMIT ?, ?
        `,
          [userId, userId, q, like, like, ...pageParams]
        );
        rows = r;
      } else {
        // discover: search, show membership flag for current user
        const [r] = await db.query(
          `
          SELECT g.group_id, g.group_name, g.group_title, g.group_description,
                 g.group_picture, g.group_members, g.group_privacy, g.group_date,
                 CASE WHEN m.user_id IS NULL THEN '0' ELSE '1' END AS joined,
                 m.approved
            FROM groups g
            LEFT JOIN groups_members m
              ON m.group_id = g.group_id AND m.user_id = ?
           WHERE (? = '' OR g.group_name LIKE ? OR g.group_title LIKE ?)
           ORDER BY g.group_members DESC, g.group_date DESC
           LIMIT ?, ?
        `,
          [userId, q, like, like, ...pageParams]
        );
        rows = r;
      }

      const hasMore = rows.length > limit;
      res.json({
        items: hasMore ? rows.slice(0, limit) : rows,
        nextCursor: hasMore ? Number(cursor) + Number(limit) : null,
      });
    } catch (e) {
      console.error('[GET /groups]', e);
      res.status(500).json({ error: 'Failed to load groups' });
    }
  }
);

// POST /api/groups/:id/join
router.post(
  '/:id/join',
  ensureAuth,
  [param('id').isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const groupId = Number(req.params.id);

    try {
      // check if already member (unique (group_id,user_id)) :contentReference[oaicite:4]{index=4}
      const [[exists]] = await db.query(
        'SELECT id, approved FROM groups_members WHERE group_id=? AND user_id=?',
        [groupId, userId]
      );
      if (exists) {
        return res.json({ joined: true, approved: exists.approved === '1' });
      }

      // read privacy to decide auto-approve or pending
      const [[g]] = await db.query(
        'SELECT group_privacy FROM groups WHERE group_id=?',
        [groupId]
      ); // privacy comes from groups table :contentReference[oaicite:5]{index=5}
      if (!g) return res.status(404).json({ error: 'Group not found' });

      const autoApprove = g.group_privacy === 'public' ? '1' : '0';
      await db.query(
        'INSERT INTO groups_members (group_id, user_id, approved) VALUES (?,?,?)',
        [groupId, userId, autoApprove]
      );
      res.status(201).json({ joined: true, approved: autoApprove === '1' });
    } catch (e) {
      // handle duplicate unique key defensively
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.json({ joined: true });
      }
      console.error('[POST /groups/:id/join]', e);
      res.status(500).json({ error: 'Join failed' });
    }
  }
);

// DELETE /api/groups/:id/leave
router.delete(
  '/:id/leave',
  ensureAuth,
  [param('id').isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const groupId = Number(req.params.id);

    try {
      await db.query(
        'DELETE FROM groups_members WHERE group_id=? AND user_id=?',
        [groupId, userId]
      );
      res.json({ joined: false });
    } catch (e) {
      console.error('[DELETE /groups/:id/leave]', e);
      res.status(500).json({ error: 'Leave failed' });
    }
  }
);

module.exports = router;
