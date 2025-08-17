// server/routes/groupPosts.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();
const pool = require('../db');
const { ensureAuth } = require('../middleware/auth');
const { upload } = require('../lib/multerUpload');
const { v4: uuidv4 } = require('uuid');

// List posts in a group (with enrich)
router.get('/:groupId', ensureAuth, param('groupId').isInt(), async (req, res, next) => {
  try {
    const gid = Number(req.params.groupId);
    // Must be member to view if private
    const [[g]] = await pool.query('SELECT privacy FROM groups WHERE id=?', [gid]);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (g.privacy === 'private') {
      const [m] = await pool.query('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?', [gid, req.user.userId]);
      if (!m.length) return res.status(403).json({ error: 'Join to view' });
    }

    const [posts] = await pool.query(
      `SELECT p.id,p.group_id AS groupId,p.user_id AS authorId,u.user_name AS authorUsername,u.profile_image AS authorAvatar,
              p.content,p.created_at AS createdAt
         FROM group_posts p
         JOIN users u ON u.user_id = p.user_id
        WHERE p.group_id = ?
        ORDER BY p.created_at DESC
        LIMIT 50`,
      [gid]
    );

    const postIds = posts.map(p => p.id);
    let media=[], likes=[], comments=[];
    if (postIds.length) {
      [media] = await pool.query(`SELECT post_id,url,type FROM group_post_media WHERE post_id IN (?)`, [postIds]);
      [likes] = await pool.query(`
        SELECT l.post_id,l.user_id AS userId,u.user_name AS username
          FROM group_post_likes l JOIN users u ON u.user_id = l.user_id
         WHERE l.post_id IN (?)`, [postIds]);
      [comments] = await pool.query(`
        SELECT c.post_id,c.id,c.user_id AS userId,u.user_name AS username,u.profile_image AS avatar,
               c.content,c.created_at AS createdAt
          FROM group_post_comments c JOIN users u ON u.user_id = c.user_id
         WHERE c.post_id IN (?) ORDER BY c.created_at ASC`, [postIds]);
    }

    const grouped = posts.map(p => ({
      id: p.id,
      content: p.content,
      createdAt: p.createdAt,
      author: { id: p.authorId, username: p.authorUsername, profileImage: p.authorAvatar },
      images: media.filter(m => m.post_id === p.id && m.type === 'image').map(m => m.url),
      videos: media.filter(m => m.post_id === p.id && m.type === 'video').map(m => m.url),
      likes: likes.filter(l => l.post_id === p.id).map(l => ({ userId: l.userId, username: l.username })),
      comments: comments.filter(c => c.post_id === p.id).map(c => ({
        id: c.id, userId: c.userId, username: c.username, avatar: c.avatar, content: c.content, createdAt: c.createdAt
      }))
    }));

    res.json(grouped);
  } catch (e) { next(e); }
});

// Create post (text + media)
router.post(
  '/:groupId',
  ensureAuth,
  param('groupId').isInt(),
  upload.array('files', 6),
  body('content').optional().isLength({ max: 5000 }),
  async (req, res, next) => {
    try {
      const gid = Number(req.params.groupId);
      const userId = req.user.userId;
      const content = (req.body.content || '').trim();

      const [m] = await pool.query('SELECT role FROM group_members WHERE group_id=? AND user_id=?', [gid, userId]);
      if (!m.length) return res.status(403).json({ error: 'Join group to post' });

      const [r] = await pool.query('INSERT INTO group_posts (group_id,user_id,content) VALUES (?,?,?)', [gid, userId, content || null]);
      const postId = r.insertId;

      if (req.files?.length) {
        const values = req.files.map(f => [
          postId,
          `${req.protocol}://${req.get('host')}/${f.path.replace(/\\/g,'/')}`,
          f.mimetype.startsWith('video') ? 'video' : 'image'
        ]);
        await pool.query('INSERT INTO group_post_media (post_id,url,type) VALUES ?', [values]);
      }

      res.status(201).json({ id: postId });
    } catch (e) { next(e); }
  }
);

// Like / Unlike
router.post('/:groupId/:postId/like', ensureAuth, async (req, res, next) => {
  try {
    const postId = Number(req.params.postId);
    const userId = req.user.userId;

    const [ex] = await pool.query('SELECT 1 FROM group_post_likes WHERE post_id=? AND user_id=?', [postId, userId]);
    if (ex.length) {
      await pool.query('DELETE FROM group_post_likes WHERE post_id=? AND user_id=?', [postId, userId]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT INTO group_post_likes (post_id,user_id) VALUES (?,?)', [postId, userId]);
    res.json({ liked: true });
  } catch (e) { next(e); }
});

// Comment
router.post('/:groupId/:postId/comment', ensureAuth, body('content').trim().isLength({ min:1 }), async (req, res, next) => {
  try {
    const postId = Number(req.params.postId);
    const userId = req.user.userId;
    const commentId = uuidv4();
    await pool.query(
      'INSERT INTO group_post_comments (id,post_id,user_id,content) VALUES (?,?,?,?)',
      [commentId, postId, userId, req.body.content]
    );
    res.status(201).json({ id: commentId, createdAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

module.exports = router;
