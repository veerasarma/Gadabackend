// packageService.js
const pool = require("../config/db");

/**
 * Check active package for a user
 * @param {number} userId 
 * @returns {Promise<{active: boolean, packageName: string|null, expiresAt: string|null}>}
 */
// async function checkActivePackage(userId) {
//   // 1) latest payment (by name) from packages_payments
//   const [payRows] = await pool.query(
//     `SELECT package_name, payment_date
//        FROM packages_payments
//       WHERE user_id = ?
//       ORDER BY payment_date DESC
//       LIMIT 1`,
//     [userId]
//   );

//   if (!payRows.length) {
//     return { active: false, packageName: null, expiresAt: null };
//   }

//   const { package_name, payment_date } = payRows[0];
//   const purchaseDate = new Date(payment_date);
//   let expiryDate = new Date(purchaseDate);

//   // 2) expiry windows (your original rule)
//   if (package_name === 'GADA VIP') {
//     expiryDate.setDate(expiryDate.getDate() + 30);
//   } else if (package_name === 'GADA VVIP') {
//     expiryDate.setDate(expiryDate.getDate() + 365);
//   } else {
//     // Unknown package name → treat as not active
//     return { active: false, packageName: null, expiresAt: null };
//   }

//   const now = new Date();
//   const isActive = now <= expiryDate;

//   if (!isActive) {
//     return { active: false, packageName: null, expiresAt: expiryDate.toISOString() };
//   }

//   // 3) fetch benefits by package *name* from packages table
//   const [pkgRows] = await pool.query(
//     `SELECT
//         package_id,
//         name,
//         price,
//         verification_badge_enabled,
//         boost_posts_enabled,
//         boost_posts,
//         boost_pages_enabled,
//         boost_pages,
//         allowed_blogs_categories,
//         allowed_videos_categories,
//         allowed_products
//        FROM packages
//       WHERE name = ?
//       LIMIT 1`,
//     [package_name]
//   );

//   // default benefits if missing row (shouldn’t happen if names match)
//   const pkg = pkgRows[0] || {};
//   const verificationBadgeEnabled = String(pkg.verification_badge_enabled || '0') === '1';
//   const boostPostsEnabled       = String(pkg.boost_posts_enabled || '0') === '1';
//   const boostPagesEnabled       = String(pkg.boost_pages_enabled || '0') === '1';
//   const boostPostsLimit         = Number(pkg.boost_posts || 0);
//   const boostPagesLimit         = Number(pkg.boost_pages || 0);

//   // 4) usage counters from users
//   const [usageRows] = await pool.query(
//     `SELECT
//         COALESCE(user_boosted_posts, 0) AS boostedPostsUsed,
//         COALESCE(user_boosted_pages, 0) AS boostedPagesUsed
//        FROM users
//       WHERE user_id = ?
//       LIMIT 1`,
//     [userId]
//   );
//   const usage = usageRows[0] || { boostedPostsUsed: 0, boostedPagesUsed: 0 };

//   const boostedPostsRemaining = Math.max(0, boostPostsLimit - Number(usage.boostedPostsUsed || 0));
//   const boostedPagesRemaining = Math.max(0, boostPagesLimit - Number(usage.boostedPagesUsed || 0));

//   return {
//     active: true,
//     packageName: package_name,
//     expiresAt: expiryDate.toISOString(),

//     benefits: {
//       name: pkg.name || package_name,
//       price: pkg.price != null ? Number(pkg.price) : null,
//       verificationBadgeEnabled,
//       boostPostsEnabled,
//       boostPostsLimit,
//       boostPagesEnabled,
//       boostPagesLimit,
//       allowedBlogsCategories: Number(pkg.allowed_blogs_categories || 0),
//       allowedVideosCategories: Number(pkg.allowed_videos_categories || 0),
//       allowedProducts: Number(pkg.allowed_products || 0),
//     },

//     usage: {
//       boostedPostsUsed: Number(usage.boostedPostsUsed || 0),
//       boostedPostsRemaining,
//       boostedPagesUsed: Number(usage.boostedPagesUsed || 0),
//       boostedPagesRemaining,
//     },

//     // convenience flags for UI/guards
//     canBoostPosts:  boostPostsEnabled && boostedPostsRemaining > 0,
//     canBoostPages:  boostPagesEnabled && boostedPagesRemaining > 0,
//   };
// }

// Assumes `pool` is a mysql2 pool instance

// Assumes `pool` is a mysql2 pool instance

async function checkActivePackage(userId) {
  // ---- 1) read subscription flags + usage from users ----
  const [userRows] = await pool.query(
    `SELECT
       user_subscribed, user_package, user_subscription_date,
       COALESCE(user_boosted_posts, 0) AS boostedPostsUsed,
       COALESCE(user_boosted_pages, 0) AS boostedPagesUsed
     FROM users
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );

  const u = userRows[0] || {};
  const userSubscribed = (u.user_subscribed === 1 || u.user_subscribed === '1');
  const userPkgId = u.user_package ? Number(u.user_package) : null;
  const userSubDate = u.user_subscription_date ? new Date(u.user_subscription_date) : null;

  // If missing any required subscription piece → inactive
  if (!userSubscribed || !userPkgId || !userSubDate || Number.isNaN(userSubDate.getTime())) {
    return { active: false, packageName: null, expiresAt: null };
  }

  // ---- 2) read package row by id (name, price, benefits, duration) ----
  const [pkgRows] = await pool.query(
    `SELECT
       package_id,
       name,
       price,
       period_num,
       period,
       verification_badge_enabled,
       boost_posts_enabled,
       boost_posts,
       boost_pages_enabled,
       boost_pages,
       allowed_blogs_categories,
       allowed_videos_categories,
       allowed_products
     FROM packages
     WHERE package_id = ?
     LIMIT 1`,
    [userPkgId]
  );

  const pkg = pkgRows[0] || null;
  if (!pkg) {
    // No such package id → treat as inactive
    return { active: false, packageName: null, expiresAt: null };
  }

  // ---- 3) compute expiry from package duration (fallback to name rules) ----
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
  const addYears = (d, n) => { const x = new Date(d); x.setFullYear(x.getFullYear() + n); return x; };
  const toIsoOrNull = (d) => (d ? new Date(d).toISOString() : null);

  let expiryDate = null;
  const num = Number(pkg.period_num || 0);
  const unit = String(pkg.period || '').toLowerCase().trim(); // "day(s)","week(s)","month(s)","year(s)"

  if (num > 0 && unit) {
    if (unit.startsWith('day'))   expiryDate = addDays(userSubDate, num);
    else if (unit.startsWith('week'))  expiryDate = addDays(userSubDate, num * 7);
    else if (unit.startsWith('month')) expiryDate = addMonths(userSubDate, num);
    else if (unit.startsWith('year'))  expiryDate = addYears(userSubDate, num);
  }

  // Fallback for legacy name-based plans (if period_* not set)
  if (!expiryDate) {
    if (pkg.name === 'GADA VIP')  expiryDate = addDays(userSubDate, 30);
    else if (pkg.name === 'GADA VVIP') expiryDate = addDays(userSubDate, 365);
  }

  if (!expiryDate) {
    // couldn’t determine an expiry → consider inactive
    return { active: false, packageName: null, expiresAt: null };
  }

  // ---- 4) active check ----
  const now = new Date();
  const isActive = now <= expiryDate;
  if (!isActive) {
    return {
      active: false,
      packageName: null,
      expiresAt: toIsoOrNull(expiryDate),
    };
  }

  // ---- 5) benefits + usage (same shape & names as before) ----
  const verificationBadgeEnabled = String(pkg.verification_badge_enabled || '0') === '1';
  const boostPostsEnabled       = String(pkg.boost_posts_enabled || '0') === '1';
  const boostPagesEnabled       = String(pkg.boost_pages_enabled || '0') === '1';
  const boostPostsLimit         = Number(pkg.boost_posts || 0);
  const boostPagesLimit         = Number(pkg.boost_pages || 0);

  const boostedPostsUsed  = Number(u.boostedPostsUsed || 0);
  const boostedPagesUsed  = Number(u.boostedPagesUsed || 0);
  const boostedPostsRemaining = Math.max(0, boostPostsLimit - boostedPostsUsed);
  const boostedPagesRemaining = Math.max(0, boostPagesLimit - boostedPagesUsed);

  return {
    active: true,
    packageName: pkg.name,                    // ← from packages table
    expiresAt: toIsoOrNull(expiryDate),

    benefits: {
      name: pkg.name,
      price: pkg.price != null ? Number(pkg.price) : null,
      verificationBadgeEnabled,
      boostPostsEnabled,
      boostPostsLimit,
      boostPagesEnabled,
      boostPagesLimit,
      allowedBlogsCategories: Number(pkg.allowed_blogs_categories || 0),
      allowedVideosCategories: Number(pkg.allowed_videos_categories || 0),
      allowedProducts: Number(pkg.allowed_products || 0),
    },

    usage: {
      boostedPostsUsed,
      boostedPostsRemaining,
      boostedPagesUsed,
      boostedPagesRemaining,
    },

    // convenience flags for UI/guards
    canBoostPosts:  boostPostsEnabled && boostedPostsRemaining > 0,
    canBoostPages:  boostPagesEnabled && boostedPagesRemaining > 0,
  };
}

module.exports = { checkActivePackage };


