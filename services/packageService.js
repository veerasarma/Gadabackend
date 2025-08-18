// packageService.js
const pool = require("../config/db");

/**
 * Check active package for a user
 * @param {number} userId 
 * @returns {Promise<{active: boolean, packageName: string|null, expiresAt: string|null}>}
 */
async function checkActivePackage(userId) {
  const query = `
    SELECT package_name, payment_date
    FROM packages_payments
    WHERE user_id = ?
    ORDER BY payment_date DESC
    LIMIT 1;
  `;

  const [rows] = await pool.query(query, [userId]);

  if (rows.length === 0) {
    return { active: false, packageName: null, expiresAt: null };
  }

  const { package_name, payment_date } = rows[0];
  const purchaseDate = new Date(payment_date);
  let expiryDate;

  if (package_name === "GADA VIP") {
    expiryDate = new Date(purchaseDate);
    expiryDate.setDate(expiryDate.getDate() + 30);
  } else if (package_name === "GADA VVIP") {
    expiryDate = new Date(purchaseDate);
    expiryDate.setDate(expiryDate.getDate() + 365);
  } else {
    return { active: false, packageName: null, expiresAt: null };
  }

  const now = new Date();
  const isActive = now <= expiryDate;

  return {
    active: isActive,
    packageName: isActive ? package_name : null,
    expiresAt: expiryDate.toISOString(),
  };
}

module.exports = { checkActivePackage };
