// routes/postViews.js
const { Router } = require('express');
const { body, param, validationResult } = require('express-validator');
const { ensureAuth } = require('../middlewares/auth');
const pool = require('../config/db');
const { creditPoints } = require('../utils/points');
const { checkActivePackage } = require('../services/packageService');

const router = Router();

/**
 * Helper: process one post view (viewer -> author credit)
 */
async function handleSingleView({ req, postId, viewerId }) {
  const sys = (req.system) || {};
  const dedupHours = Number(sys.POINTS_VIEW_DEDUP_HOURS ?? 12); // once per 12h per viewer+post

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Find author
    const [[post]] = await conn.query(
      'SELECT user_id AS authorId FROM posts WHERE post_id = ? LIMIT 1',
      [postId]
    );
    if (!post) {
      await conn.rollback();
      conn.release();
      return { ok: false, status: 404, error: 'Post not found' };
    }
    const authorId = Number(post.authorId);

    // 2) Skip self-views
    if (authorId === Number(viewerId)) {
      await conn.rollback();
      conn.release();
      return { ok: true, awarded: 0, reason: 'self_view' };
    }

    // 3) Check de-dup window per viewer+post
    // const [seenRows] = await conn.query(
    //   `SELECT id FROM post_view_events
    //     WHERE post_id=? AND viewer_id=? AND time >= (NOW() - INTERVAL ? HOUR)
    //     LIMIT 1`,
    //   [postId, viewerId, dedupHours]
    // );
    // if (seenRows.length) {
    //   await conn.rollback();
    //   conn.release();
    //   return { ok: true, awarded: 0, reason: 'dedup_window' };
    // }

    // 4) Insert a view event (gives us a unique id to use as nodeId)
    const [ins] = await conn.query(
      `INSERT INTO post_view_events (post_id, viewer_id, time)
       VALUES (?, ?, NOW())`,
      [postId, viewerId]
    );
   
    const [ins1] = await conn.query(
      `INSERT INTO posts_views (post_id, user_id, view_date)
       VALUES (?, ?, NOW())`,
      [postId, viewerId]
    );
    const viewEventId = ins.insertId;

    await conn.commit();
    conn.release();

    // 5) Credit the AUTHOR (not the viewer) for the view
    //    Uses your creditPoints helper (daily limit enforced there).
    try {
      const award = await creditPoints({
        pool,
        userId: authorId,          // credit goes to post author
        nodeId: viewEventId,       // unique per qualifying view
        type: 'post_view',         // uses sys.points_per_post_view
        req,
        checkActivePackage,
      });
      return { ok: true, awarded: award?.awarded || 0, reason: award?.reason || 'ok' };
    } catch (e) {
      // Points failing should not break the UX
      return { ok: true, awarded: 0, reason: 'points_error' };
    }
  } catch (err) {
    await conn.rollback();
    conn.release();
    return { ok: false, status: 500, error: err.message || String(err) };
  }
}

/** Single post view */
router.post(
  '/:id/view',
  ensureAuth,
  param('id').isInt().toInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const postId = req.params.id;
    const viewerId = req.user.userId;

    const result = await handleSingleView({ req, postId, viewerId });
    if (!result.ok && result.status)
      return res.status(result.status).json({ error: result.error });
    return res.json(result);
  }
);

/** Batch post views */
router.post(
  '/batch',
  ensureAuth,
  body('ids').isArray({ min: 1 }),
  body('ids.*').isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const viewerId = req.user.userId;
    const ids = req.body.ids.map(Number);

    const results = await Promise.all(
      ids.map((postId) => handleSingleView({ req, postId, viewerId }))
    );

    // Aggregate simple stats for the caller
    const awarded = results.reduce((s, r) => s + (r.awarded || 0), 0);
    return res.json({ ok: true, total: ids.length, awarded, results });
  }
);

module.exports = router;
