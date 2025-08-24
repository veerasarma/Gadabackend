// packageService.js
const pool = require("../config/db");

/**
 * Check active package for a user
 * @param {number} userId 
 * @returns {Promise<{active: boolean, packageName: string|null, expiresAt: string|null}>}
 */
async function checkActivePackage(userId) {
  // 1) latest payment (by name) from packages_payments
  const [payRows] = await pool.query(
    `SELECT package_name, payment_date
       FROM packages_payments
      WHERE user_id = ?
      ORDER BY payment_date DESC
      LIMIT 1`,
    [userId]
  );

  if (!payRows.length) {
    return { active: false, packageName: null, expiresAt: null };
  }

  const { package_name, payment_date } = payRows[0];
  const purchaseDate = new Date(payment_date);
  let expiryDate = new Date(purchaseDate);

  // 2) expiry windows (your original rule)
  if (package_name === 'GADA VIP') {
    expiryDate.setDate(expiryDate.getDate() + 30);
  } else if (package_name === 'GADA VVIP') {
    expiryDate.setDate(expiryDate.getDate() + 365);
  } else {
    // Unknown package name → treat as not active
    return { active: false, packageName: null, expiresAt: null };
  }

  const now = new Date();
  const isActive = now <= expiryDate;

  if (!isActive) {
    return { active: false, packageName: null, expiresAt: expiryDate.toISOString() };
  }

  // 3) fetch benefits by package *name* from packages table
  const [pkgRows] = await pool.query(
    `SELECT
        package_id,
        name,
        price,
        verification_badge_enabled,
        boost_posts_enabled,
        boost_posts,
        boost_pages_enabled,
        boost_pages,
        allowed_blogs_categories,
        allowed_videos_categories,
        allowed_products
       FROM packages
      WHERE name = ?
      LIMIT 1`,
    [package_name]
  );

  // default benefits if missing row (shouldn’t happen if names match)
  const pkg = pkgRows[0] || {};
  const verificationBadgeEnabled = String(pkg.verification_badge_enabled || '0') === '1';
  const boostPostsEnabled       = String(pkg.boost_posts_enabled || '0') === '1';
  const boostPagesEnabled       = String(pkg.boost_pages_enabled || '0') === '1';
  const boostPostsLimit         = Number(pkg.boost_posts || 0);
  const boostPagesLimit         = Number(pkg.boost_pages || 0);

  // 4) usage counters from users
  const [usageRows] = await pool.query(
    `SELECT
        COALESCE(user_boosted_posts, 0) AS boostedPostsUsed,
        COALESCE(user_boosted_pages, 0) AS boostedPagesUsed
       FROM users
      WHERE user_id = ?
      LIMIT 1`,
    [userId]
  );
  const usage = usageRows[0] || { boostedPostsUsed: 0, boostedPagesUsed: 0 };

  const boostedPostsRemaining = Math.max(0, boostPostsLimit - Number(usage.boostedPostsUsed || 0));
  const boostedPagesRemaining = Math.max(0, boostPagesLimit - Number(usage.boostedPagesUsed || 0));

  return {
    active: true,
    packageName: package_name,
    expiresAt: expiryDate.toISOString(),

    benefits: {
      name: pkg.name || package_name,
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
      boostedPostsUsed: Number(usage.boostedPostsUsed || 0),
      boostedPostsRemaining,
      boostedPagesUsed: Number(usage.boostedPagesUsed || 0),
      boostedPagesRemaining,
    },

    // convenience flags for UI/guards
    canBoostPosts:  boostPostsEnabled && boostedPostsRemaining > 0,
    canBoostPages:  boostPagesEnabled && boostedPagesRemaining > 0,
  };
}

module.exports = { checkActivePackage };
