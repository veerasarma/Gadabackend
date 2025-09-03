// helpers/affiliatesHelper.js
// Usage: const { awardAffiliateCommissions } = require('../helpers/affiliatesHelper');

const PCT_KEYS = [
    'affiliates_percentage',
    'affiliates_percentage_2',
    // tolerate the user's typo; try _3 then per_user_3
    'affiliates_percentage_3',
    'affiliates_percentage_4',
    'affiliates_percentage_5',
  ];
  
  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  
  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }
  
  /**
   * Resolve global affiliate levels & percentages from system_options.
   * Accepts typos like "affiliates_per_user_3" for level 3 percentage.
   */
  async function loadGlobalAffSettings(conn) {
    // get level count
    const [lvRows] = await conn.query(
      `SELECT option_value FROM system_options WHERE LOWER(option_name)='affiliates_levels' LIMIT 1`
    );
    const levels = toNum(lvRows?.[0]?.option_value, 1);
  
    // fetch all possible percentage keys we might need up to 5
    const percentNames = [
      'affiliates_percentage',
      'affiliates_percentage_2',
      'affiliates_percentage_3',
      'affiliates_per_user_3', // tolerate typo
      'affiliates_percentage_4',
      'affiliates_percentage_5',
    ];
  
    const [pctRows] = await conn.query(
      `SELECT option_name, option_value
         FROM system_options
        WHERE LOWER(option_name) IN (${percentNames.map(() => '?').join(',')})`,
      percentNames
    );
  
    const map = {};
    for (const r of pctRows || []) {
      map[r.option_name.toLowerCase()] = r.option_value;
    }
  
    const getPct = (idx) => {
      // idx: 1..5
      if (idx === 1) return toNum(map['affiliates_percentage'], 0);
      if (idx === 2) return toNum(map['affiliates_percentage_2'], 0);
      if (idx === 3) {
        // prefer correct key; fall back to the typo if present
        const v = map['affiliates_percentage_3'];
        return v != null ? toNum(v, 0) : toNum(map['affiliates_per_user_3'], 0);
      }
      if (idx === 4) return toNum(map['affiliates_percentage_4'], 0);
      if (idx === 5) return toNum(map['affiliates_percentage_5'], 0);
      return 0;
    };
  
    // build an array of length = levels (capped at 5 for safety)
    const capped = Math.min(Math.max(1, levels), 5);
    const percents = Array.from({ length: capped }, (_, i) => getPct(i + 1));
  
    return { levels: capped, percents };
  }
  
  /**
   * Get direct referrer of a user: prefer users.user_referrer_id,
   * else fall back to users_affiliates(referee_id -> referrer_id).
   */
  async function getDirectReferrer(conn, userId) {
    // 1) check users table
    const [u] = await conn.query(
      `SELECT user_referrer_id FROM users WHERE user_id=? LIMIT 1`,
      [userId]
    );
    const direct = u?.[0]?.user_referrer_id ? Number(u[0].user_referrer_id) : null;
    if (direct) return direct;
  
    // 2) fallback: link table
    const [a] = await conn.query(
      `SELECT referrer_id FROM users_affiliates WHERE referee_id=? LIMIT 1`,
      [userId]
    );
    return a?.[0]?.referrer_id ? Number(a[0].referrer_id) : null;
  }
  
  /**
   * If referrer uses custom affiliates system, return their per-level percentage for the given level idx (1..5).
   * Otherwise return null (meaning: use global).
   */
  async function maybeGetReferrerCustomPct(conn, referrerId, levelIdx) {
    const cols = `
      custom_affiliates_system,
      affiliates_percentage,
      affiliates_percentage_2,
      affiliates_percentage_3,
      affiliates_percentage_4,
      affiliates_percentage_5
    `;
    const [rows] = await conn.query(
      `SELECT ${cols} FROM users WHERE user_id=? LIMIT 1`,
      [referrerId]
    );
    if (!rows?.length) return null;
  
    const row = rows[0];
    if (String(row.custom_affiliates_system) !== '1') return null;
  
    const fieldMap = {
      1: 'affiliates_percentage',
      2: 'affiliates_percentage_2',
      3: 'affiliates_percentage_3',
      4: 'affiliates_percentage_4',
      5: 'affiliates_percentage_5',
    };
    const key = fieldMap[levelIdx];
    if (!key) return null;
  
    // Some DBs might have NULL; treat as no override
    const v = row[key];
    return v == null ? null : toNum(v, 0);
  }
  
  /**
   * Award multi-level affiliate commissions.
   *
   * @param {import('mysql2/promise').Pool} pool
   * @param {number} purchaserId  New buyer's user_id
   * @param {number} grossAmount  The base amount to compute percentages on
   * @param {{ conn?: any, reason?: string, referenceId?: string|number }} [opts]
   * @returns {Promise<{awards: Array<{level:number, referrerId:number, percent:number, amount:number}>}>}
   */
  async function awardAffiliateCommissions(pool, purchaserId, grossAmount, opts = {}) {
    if (!Number.isFinite(purchaserId) || purchaserId <= 0) {
      throw new Error('Invalid purchaserId');
    }
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      // nothing to do
      return { awards: [] };
    }
  
    const externalConn = !!opts.conn;
    const conn = opts.conn || (await pool.getConnection());
  
    try {
      if (!externalConn) await conn.beginTransaction();
  
      // 1) global settings
      const { levels, percents } = await loadGlobalAffSettings(conn);
  
      // 2) build upline chain up to {levels}
      const chain = [];
      let current = purchaserId;
      const visited = new Set([current]); // prevent loops
  
      for (let i = 0; i < levels; i++) {
        const parent = await getDirectReferrer(conn, current);
        if (!parent || visited.has(parent)) break;
        chain.push(parent);
        visited.add(parent);
        current = parent;
      }
  
      const awards = [];
  
      // 3) compute + credit each level
      for (let i = 0; i < chain.length; i++) {
        const levelIdx = i + 1;
        const referrerId = chain[i];
  
        // Prefer custom pct for this referrer+level; else use global pct
        const customPct = await maybeGetReferrerCustomPct(conn, referrerId, levelIdx);
        const pct = customPct != null ? customPct : (percents[i] || 0);
  
        if (!pct || pct <= 0) continue;
  
        const amount = round2((pct / 100) * grossAmount);
        if (amount <= 0) continue;
  
        // Credit to user_affiliate_balance
        await conn.query(
          `UPDATE users
              SET user_affiliate_balance = user_affiliate_balance + ?
            WHERE user_id = ?`,
          [amount, referrerId]
        );
  
        // (Optional) If you later add a ledger table, insert here.
  
        awards.push({ level: levelIdx, referrerId, percent: pct, amount });
      }
  
      if (!externalConn) await conn.commit();
      return { awards };
    } catch (e) {
      if (!externalConn) { try { await conn.rollback(); } catch {} }
      throw e;
    } finally {
      if (!externalConn) conn.release();
    }
  }
  
  module.exports = { awardAffiliateCommissions };
  