// routes/search.js
const express = require('express');
const pool = require('../config/db'); // mysql2/promise pool
const router = express.Router();

function sanitizeQ(q='') {
  return q.trim().replace(/\s+/g, ' ');
}
function isHashtagQuery(q) {
  return q.startsWith('#');
}
function makeLike(s) {
  return s.replace(/[%_]/g, m => '\\' + m) + '%';
}

// ---------- /api/search/suggest ----------
router.get('/suggest', async (req, res) => {
  try {
    const raw = String(req.query.q || '');
    const q = sanitizeQ(raw);
    if (q.length < 2) return res.json({ top: [], users: [], posts: [], tags: [] });

    // Heuristics
    const hashtagFirst = isHashtagQuery(q);
    const plain = hashtagFirst ? q.slice(1) : q;
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

    // TAGS
    const [tagRows] = await pool.query(
        `
        SELECT h.hashtag_id AS id,
               h.hashtag    AS tag,
               COALESCE(cnt.c, 0) AS count
          FROM hashtags h
          LEFT JOIN (
            SELECT hashtag_id, COUNT(*) c FROM hashtags_posts GROUP BY hashtag_id
          ) cnt ON cnt.hashtag_id = h.hashtag_id
         WHERE LOWER(h.hashtag) LIKE CONCAT(?, '%')
         ORDER BY cnt.c DESC, h.hashtag ASC
         LIMIT 5
        `,
        [qLower]
      );
    // POSTS (short snippet)
    const [postRows] = await pool.query(
        `
        SELECT p.post_id AS id,
               SUBSTRING(p.text, 1, 160) AS snippet,
               u.user_id AS author_id,
               u.user_name AS author_username,
               u.user_picture AS author_avatar
          FROM posts p
          JOIN users u ON u.user_id = p.user_id
         WHERE LOWER(p.text) LIKE CONCAT('%', ?, '%')
           AND p.is_hidden = '0'
         ORDER BY p.post_id DESC
         LIMIT 3
        `,
        [qLower]
      );
    // Build "top" mixed results: prefer hashtags if query started with '#'
    const users = userRows.map(r => ({
      id: r.id, username: r.username, fullName: r.fullName, avatar: r.avatar
    }));

    const tags = tagRows.map(r => ({ id: r.id, tag: r.tag, count: Number(r.count || 0) }));

    const posts = postRows.map(r => ({
      id: r.id,
      snippet: escapeHtml(r.snippet || ''),
      author: { id: r.author_id, username: r.author_username, avatar: r.author_avatar }
    }));

    const top = [];
    if (hashtagFirst) {
      // tag -> user -> post
      tags.slice(0, 3).forEach(t => top.push({ kind:'tag', data: t }));
      users.slice(0, 2).forEach(u => top.push({ kind:'user', data: u }));
      posts.slice(0, 1).forEach(p => top.push({ kind:'post', data: p }));
    } else {
      // user -> tag -> post
      users.slice(0, 3).forEach(u => top.push({ kind:'user', data: u }));
      tags.slice(0, 2).forEach(t => top.push({ kind:'tag', data: t }));
      posts.slice(0, 1).forEach(p => top.push({ kind:'post', data: p }));
    }

    res.json({ top, users, posts, tags });
  } catch (err) {
    console.error('[GET /api/search/suggest]', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---------- /api/search (paged) ----------
router.get('/', async (req, res) => {
  try {
    const raw = String(req.query.q || '');
    const q = sanitizeQ(raw);
    const type = String(req.query.type || 'all'); // all|users|posts|hashtags
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || '20'), 10)));
    const offset = (page - 1) * limit;

    if (q.length < 2) return res.json({ q, type, page, limit, users:[], posts:[], tags:[], total:{users:0, posts:0, tags:0} });

    const hashtagFirst = isHashtagQuery(q);
    const plain = hashtagFirst ? q.slice(1) : q;
    const like = makeLike(plain.toLowerCase());

    const out = { users:[], posts:[], tags:[], total:{users:0, posts:0, tags:0} };

    if (type === 'all' || type === 'users') {
      const [rows] = await pool.query(
        `
        SELECT SQL_CALC_FOUND_ROWS
               u.user_id AS id,
               u.user_name AS username,
               CONCAT_WS(' ', u.user_firstname, u.user_lastname) AS fullName,
               u.user_picture AS avatar
          FROM users u
         WHERE (LOWER(u.user_name) LIKE ? ESCAPE '\\'
            OR  LOWER(u.user_firstname) LIKE ? ESCAPE '\\'
            OR  LOWER(u.user_lastname) LIKE ? ESCAPE '\\')
         ORDER BY u.user_id DESC
         LIMIT ? OFFSET ?
        `,
        [like, like, like, limit, offset]
      );
      const [[{ 'FOUND_ROWS()': totalUsers }]] = await pool.query(`SELECT FOUND_ROWS()`);
      out.users = rows;
      out.total.users = Number(totalUsers || 0);
    }

    if (type === 'all' || type === 'posts') {
      const [rows] = await pool.query(
        `
        SELECT SQL_CALC_FOUND_ROWS
               p.post_id AS id,
               u.user_id AS author_id,
               u.user_name AS author_username,
               u.user_picture AS author_avatar,
               SUBSTRING(p.text, 1, 300) AS snippet
          FROM posts p
          JOIN users u ON u.user_id = p.user_id
         WHERE LOWER(p.text) LIKE ? ESCAPE '\\'
           AND p.is_hidden = '0'
         ORDER BY p.post_id DESC
         LIMIT ? OFFSET ?
        `,
        [like, limit, offset]
      );
      const [[{ 'FOUND_ROWS()': totalPosts }]] = await pool.query(`SELECT FOUND_ROWS()`);
      out.posts = rows.map(r => ({
        id: r.id,
        snippet: escapeHtml(r.snippet || ''),
        author: { id: r.author_id, username: r.author_username, avatar: r.author_avatar }
      }));
      out.total.posts = Number(totalPosts || 0);
    }

    if (type === 'all' || type === 'hashtags') {
      const [rows] = await pool.query(
        `
        SELECT SQL_CALC_FOUND_ROWS
               h.hashtag_id AS id,
               h.hashtag AS tag,
               COALESCE(cnt.c, 0) AS count
          FROM hashtags h
          LEFT JOIN (
            SELECT hashtag_id, COUNT(*) c FROM hashtags_posts GROUP BY hashtag_id
          ) cnt ON cnt.hashtag_id = h.hashtag_id
         WHERE LOWER(h.hashtag) LIKE ? ESCAPE '\\'
         ORDER BY cnt.c DESC, h.hashtag ASC
         LIMIT ? OFFSET ?
        `,
        [like, limit, offset]
      );
      const [[{ 'FOUND_ROWS()': totalTags }]] = await pool.query(`SELECT FOUND_ROWS()`);
      out.tags = rows;
      out.total.tags = Number(totalTags || 0);
    }

    res.json({ q, type, page, limit, ...out });
  } catch (err) {
    console.error('[GET /api/search]', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --------- utils ----------
function escapeHtml(s='') {
  return s
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

module.exports = router;
