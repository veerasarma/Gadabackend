// server/routes/affiliates.js
const express = require('express');
const router = express.Router();

const pool = require('../config/db');           // <- your mysql pool
const { ensureAuth } = require('../middlewares/auth'); // <- your auth middleware

// Helpers
async function loadOptions(prefix = 'affiliates_') {
  const [rows] = await pool.query(
    `SELECT option_name, option_value
       FROM system_options
      WHERE option_name LIKE ?`,
    [prefix + '%']
  );
  const out = {};
  for (const r of rows) out[r.option_name] = r.option_value;
  return out;
}

// Optional: base URL used to craft the share link
function siteBase(req) {
  // prefer configured public URL, fallback to request host
  const env = process.env.CLIENT_ORIGIN || process.env.SITE_URL || '';
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * GET /api/affiliates/overview
 * Returns:
 *  - enabled, levels, type, per-level settings
 *  - user balance, share link
 *  - counts per level, totals
 */
router.get('/overview', ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user.userId);

    // settings
    const S = await loadOptions('affiliates_'); // all keys given in the spec
    console.log(S,'SSS')
    const enabled  = String(S['affiliates_enabled'] || '0') === '1';
    const levels   = Math.max(1, Number(S['affiliates_levels'] || 1));
    const minWd    = Number(S['affiliates_min_withdrawal'] || 0);
    const canXfer  = String(S['affiliates_money_transfer_enabled'] || '0') === '1';
    const canWd    = String(S['affiliates_money_withdraw_enabled'] || '0') === '1';
    const type     = S['affiliate_type'] || 'percentage'; // or "per_user"
    const level1per     = S['affiliates_percentage'] || 0; // or "per_user"
    const level2per     = S['affiliates_percentage_2'] || 0; // or "per_user"
    const level3per     = S['affiliates_percentage_3'] || 0; // or "per_user"

    // user balance & username for link
    const [[me]] = await pool.query(
      `SELECT user_id, user_name,
              user_affiliate_balance, user_wallet_balance
         FROM users
        WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    // share link (like your screenshot)
    const link = `${siteBase(req)}/?ref=${encodeURIComponent(me?.user_name || String(userId))}`;

    // --- count referrals per level (users_affiliates is a flat mapping) ---
    // table: users_affiliates(id, referrer_id, referee_id) with unique index on pair
    // (see dump) :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}
    let currentLevelIds = [userId];
    const perLevel = [];
    let totalRefs = 0;

    for (let depth = 1; depth <= levels; depth++) {
      if (currentLevelIds.length === 0) { perLevel.push(0); continue; }

      const [rows] = await pool.query(
        `SELECT referee_id
           FROM users_affiliates
          WHERE referrer_id IN (?)`,
        [currentLevelIds]
      );
      const nextIds = rows.map(r => Number(r.referee_id));
      perLevel.push(nextIds.length);
      totalRefs += nextIds.length;
      currentLevelIds = nextIds;
    }

    return res.json({
      settings: {
        enabled, levels, type,
        minWithdrawal: minWd,
        transferEnabled: canXfer,
        withdrawEnabled: canWd,
        level1per: level1per,
        level2per: level2per,
        level3per: level3per,
      },
      shareLink: link,
      balance: {
        affiliate: Number(me?.user_affiliate_balance || 0), // field exists on users table
        wallet: Number(me?.user_wallet_balance || 0),
      },
      referrals: {
        perLevel,              // [L1, L2, ...]
        total: totalRefs,
      },
    });
  } catch (err) {
    console.error('[affiliates/overview]', err);
    res.status(500).json({ error: 'Failed to load affiliates overview' });
  }
});

/**
 * GET /api/affiliates/referrals
 * Query: page=1&limit=20&level=1&search=abc
 * Returns paginated direct/deeper referrals with basic user info
 */
router.get('/referrals', ensureAuth, async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    const page   = Math.max(1, Number(req.query.page || 1));
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const level  = Math.max(1, Number(req.query.level || 1));
    const search = String(req.query.search || '').trim();

    // Build IDs for the requested level
    let frontier = [userId];
    for (let d = 1; d <= level; d++) {
      if (frontier.length === 0) break;
      const [rows] = await pool.query(
        `SELECT referee_id
           FROM users_affiliates
          WHERE referrer_id IN (?)`,
        [frontier]
      );
      frontier = rows.map(r => Number(r.referee_id));
      if (d === level) break;
    }
    const ids = frontier;

    if (ids.length === 0) {
      return res.json({ items: [], total: 0, page, limit });
    }

    // build WHERE
    const where = ['user_id IN (?)'];
    const args  = [ids];
    if (search) {
      where.push(`(user_name LIKE ? OR CONCAT_WS(' ', user_firstname, user_lastname) LIKE ?)`);
      args.push(`%${search}%`, `%${search}%`);
    }

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM users WHERE ${where.join(' AND ')}`, args
    );

    const [rows] = await pool.query(
      `SELECT user_id, user_name, user_firstname, user_lastname, user_picture, user_registered
         FROM users
        WHERE ${where.join(' AND ')}
        ORDER BY user_registered DESC
        LIMIT ? OFFSET ?`,
      args.concat([limit, (page-1)*limit])
    );

    // NOTE: affiliate balances field on users table
    // (`user_affiliate_balance` on users) :contentReference[oaicite:2]{index=2}
    const items = rows.map(u => ({
      id: Number(u.user_id),
      username: u.user_name,
      fullName: [u.user_firstname, u.user_lastname].filter(Boolean).join(' ') || u.user_name,
      avatar: u.user_picture,
      joinedAt: u.user_registered,
    }));

    res.json({ items, total: Number(countRow.c || 0), page, limit });
  } catch (err) {
    console.error('[affiliates/referrals]', err);
    res.status(500).json({ error: 'Failed to load referrals' });
  }
});

/**
 * POST /api/affiliates/transfer
 * Body: { amount: number }
 * Moves from users.user_affiliate_balance -> users.user_wallet_balance
 * Checks min withdrawal + toggle.
 */
router.post('/transfer', ensureAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = Number(req.user.userId);
    const amount = Math.max(0, Number(req.body?.amount || 0));

    const S = await loadOptions('affiliates_');
    const enabled = String(S['affiliates_money_transfer_enabled'] || '0') === '1';
    const minWd   = Number(S['affiliates_min_withdrawal'] || 0);
    if (!enabled) return res.status(400).json({ error: 'Transfer disabled' });
    if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (amount < minWd) return res.status(400).json({ error: `Minimum is ${minWd}` });

    await conn.beginTransaction();

    const [[me]] = await conn.query(
      `SELECT user_affiliate_balance, user_wallet_balance
         FROM users
        WHERE user_id = ? FOR UPDATE`,
      [userId]
    );
    const bal = Number(me?.user_affiliate_balance || 0);
    if (amount > bal) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient affiliate balance' });
    }

    await conn.query(
      `UPDATE users
          SET user_affiliate_balance = user_affiliate_balance - ?,
              user_wallet_balance    = user_wallet_balance + ?
        WHERE user_id = ?`,
      [amount, amount, userId]
    );

    await conn.commit();

    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('[affiliates/transfer]', err);
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    conn.release();
  }
});

module.exports = router;
