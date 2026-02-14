// const express = require("express");
// const axios = require("axios");
// const router = express.Router();
// const db = require("../config/db");
// const authMiddleware = require("../");
// // const auth = require("../middlewares/authMiddleware");
// const { ensureAuth } = require("../middlewares/auth");
// const { awardAffiliateCommissions } = require('../utils/affiliatesHelper');

// router.get("/", ensureAuth, async (req, res) => {
//   try {
//     const user_id = req.user.userId;

//     // 1) packages (unchanged)
//     const [packages] = await db.query(`
//       SELECT 
//         package_id,
//         name,
//         price,
//         period_num,
//         period,
//         color,
//         icon,
//         boost_posts,
//         boost_pages,
//         verification_badge_enabled,
//         custom_description
//       FROM packages
//       ORDER BY package_order ASC
//     `);

//     if (!packages.length) {
//       return res.status(404).json({ status: false, message: "No packages found" });
//     }

//     // 2) wallet (unchanged)
//     const [[wallet]] = await db.query(
//       `SELECT user_wallet_balance FROM users WHERE user_id = ?`,
//       [user_id]
//     );

//     // 3) build two "active plan" candidates and pick the newest by date
//     // 3a) from packages_payments (your previous code)
//     const [[lastPayment]] = await db.query(
//       `
//         SELECT 
//           payment_id,
//           package_name,
//           package_price,
//           payment_date
//         FROM packages_payments
//         WHERE user_id = ?
//         ORDER BY payment_date DESC
//         LIMIT 1
//       `,
//       [user_id]
//     );

//     // 3b) from users table flags (user_subscribed/user_package/user_subscription_date)
//     const [[u]] = await db.query(
//       `SELECT user_subscribed, user_package, user_subscription_date FROM users WHERE user_id = ? LIMIT 1`,
//       [user_id]
//     );

//     let userCandidate = null;
//     if (u && (u.user_subscribed === '1' || u.user_subscribed === 1) && u.user_package && u.user_subscription_date) {
//       // fetch package name/price by id
//       const [[pkgRow]] = await db.query(
//         `SELECT name, price FROM packages WHERE package_id = ? LIMIT 1`,
//         [u.user_package]
//       );
//       if (pkgRow) {
//         // ⚠ keep SAME shape as activePlan from payments
//         userCandidate = {
//           payment_id: null, // no payment row for this source
//           package_name: pkgRow.name,
//           package_price: parseFloat(pkgRow.price ?? 0) || 0,
//           payment_date: u.user_subscription_date, // treat as start date
//         };
//       }
//     }

//     // choose the newest by date (if both exist)
//     let activePlan = null;
//     if (lastPayment && userCandidate) {
//       const lpDate = new Date(lastPayment.payment_date);
//       const ucDate = new Date(userCandidate.payment_date);
//       activePlan = lpDate >= ucDate ? lastPayment : userCandidate;
//     } else {
//       activePlan = lastPayment || userCandidate || null;
//     }

//     return res.json({
//       status: true,
//       data: packages, // all packages
//       walletBalance: wallet?.user_wallet_balance || 0,
//       activePlan,     // may be null; same property names as before
//     });
//   } catch (err) {
//     console.error("Error fetching packages:", err);
//     return res.status(500).json({ status: false, message: "Database query failed" });
//   }
// });


// router.post("/buypackage", ensureAuth, async (req, res) => {
//   // frontend may post { package_id, package_name, package_price } — we will trust ONLY package_id
//   const { package_id } = req.body;
//   const user_id = req.user.userId;

//   if (!package_id) {
//     return res.status(200).json({ status: false, message: "Missing package_id" });
//   }

//   let conn;
//   try {
//     // Look up package (use DB truth, not client)
//     const [[pkg]] = await db.query(
//       `SELECT package_id, name, price FROM packages WHERE package_id = ? LIMIT 1`,
//       [package_id]
//     );
//     if (!pkg) {
//       return res.status(200).json({ status: false, message: "Package not found" });
//     }

//     const pkgPrice = parseFloat(pkg.price ?? 0) || 0;
//     const pkgName  = String(pkg.name);

//     // Get wallet balance
//     const [[userRow]] = await db.query(
//       "SELECT user_wallet_balance FROM users WHERE user_id = ?",
//       [user_id]
//     );
//     if (!userRow) {
//       return res.status(200).json({ status: false, message: "User not found" });
//     }

//     const balance = parseFloat(userRow.user_wallet_balance ?? 0);
//     if (balance < pkgPrice) {
//       return res.status(200).json({ status: false, message: "Insufficient balance" });
//     }

//     // Start transaction
//     conn = await db.getConnection();
//     await conn.beginTransaction();

//     // 1) deduct wallet
//     await conn.query(
//       "UPDATE users SET user_wallet_balance = user_wallet_balance - ? WHERE user_id = ?",
//       [pkgPrice, user_id]
//     );

//     // 2) insert payment (keep SAME columns you already use)
//     await conn.query(
//       `INSERT INTO packages_payments (payment_date, package_name, package_price, user_id)
//        VALUES (NOW(), ?, ?, ?)`,
//       [pkgName, pkgPrice, user_id]
//     );

//     // 3) update users subscription flags (authoritative for current plan)
//     await conn.query(
//       `UPDATE users
//           SET user_subscribed = '1',
//               user_package = ?,
//               user_subscription_date = NOW(),
//               user_boosted_posts = 0,
//               user_boosted_pages = 0
//         WHERE user_id = ?`,
//       [pkg.package_id, user_id]
//     );

//     await conn.commit();

//     const { awards } = await awardAffiliateCommissions(db, Number(user_id), Number(pkgPrice));

//     return res.json({ status: true, message: "Package purchased successfully" });
//   } catch (err) {
//     if (conn) {
//       try { await conn.rollback(); } catch {}
//     }
//     console.error("buy package failed:", err);
//     return res.status(500).json({ status: false, message: "Internal server error" });
//   } finally {
//     if (conn) conn.release();
//   }
// });


// module.exports = router;


const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db");
const authMiddleware = require("../");
// const auth = require("../middlewares/authMiddleware");
const { ensureAuth } = require("../middlewares/auth");
const { awardAffiliateCommissions } = require('../utils/affiliatesHelper');


// ================== GET /  (packages + wallet + activePlan) ==================
router.get("/", ensureAuth, async (req, res) => {
  try {
    const user_id = req.user.userId;

    // 1) packages (unchanged)
    const [packages] = await db.query(`
      SELECT 
        package_id,
        name,
        price,
        period_num,
        period,
        color,
        icon,
        boost_posts,
        boost_pages,
        verification_badge_enabled,
        custom_description
      FROM packages
      ORDER BY package_order ASC
    `);

    if (!packages.length) {
      return res.status(404).json({ status: false, message: "No packages found" });
    }

    // 2) wallet (unchanged)
    const [[wallet]] = await db.query(
      "SELECT user_wallet_balance FROM users WHERE user_id = ?",
      [user_id]
    );

    // 3a) last payment from packages_payments
    const [[lastPayment]] = await db.query(
      `
        SELECT 
          payment_id,
          package_name,
          package_price,
          payment_date
        FROM packages_payments
        WHERE user_id = ?
        ORDER BY payment_date DESC
        LIMIT 1
      `,
      [user_id]
    );

    // 3b) from users table flags
    const [[u]] = await db.query(
      "SELECT user_subscribed, user_package, user_subscription_date FROM users WHERE user_id = ? LIMIT 1",
      [user_id]
    );

    let userCandidate = null;
    if (
      u &&
      (u.user_subscribed === '1' || u.user_subscribed === 1) &&
      u.user_package &&
      u.user_subscription_date
    ) {
      const [[pkgRow]] = await db.query(
        "SELECT name, price FROM packages WHERE package_id = ? LIMIT 1",
        [u.user_package]
      );
      if (pkgRow) {
        userCandidate = {
          payment_id: null,
          package_name: pkgRow.name,
          package_price: parseFloat(pkgRow.price ?? 0) || 0,
          payment_date: u.user_subscription_date,
        };
      }
    }

    // choose the newest by date (if both exist)
    let activePlan = null;
    if (lastPayment && userCandidate) {
      const lpDate = new Date(lastPayment.payment_date);
      const ucDate = new Date(userCandidate.payment_date);
      activePlan = lpDate >= ucDate ? lastPayment : userCandidate;
    } else {
      activePlan = lastPayment || userCandidate || null;
    }

    return res.json({
      status: true,
      data: packages,
      walletBalance: wallet ? (wallet.user_wallet_balance || 0) : 0,
      activePlan,
    });
  } catch (err) {
    console.error("Error fetching packages:", err);
    return res.status(500).json({ status: false, message: "Database query failed" });
  }
});


// ================== POST /buypackage  (self purchase) ==================
router.post("/buypackage", ensureAuth, async (req, res) => {
  // frontend may post { package_id, package_name, package_price } — we will trust ONLY package_id
  const { package_id } = req.body;
  const user_id = req.user.userId;

  if (!package_id) {
    return res.status(200).json({ status: false, message: "Missing package_id" });
  }

  let conn;
  try {
    // Look up package (use DB truth, not client)
    const [[pkg]] = await db.query(
      "SELECT package_id, name, price FROM packages WHERE package_id = ? LIMIT 1",
      [package_id]
    );
    if (!pkg) {
      return res.status(200).json({ status: false, message: "Package not found" });
    }

    const pkgPrice = parseFloat(pkg.price ?? 0) || 0;
    const pkgName  = String(pkg.name);

    // Get wallet balance
    const [[userRow]] = await db.query(
      "SELECT user_wallet_balance FROM users WHERE user_id = ?",
      [user_id]
    );
    if (!userRow) {
      return res.status(200).json({ status: false, message: "User not found" });
    }

    const balance = parseFloat(userRow.user_wallet_balance ?? 0);
    if (balance < pkgPrice) {
      return res.status(200).json({ status: false, message: "Insufficient balance" });
    }

    // Start transaction
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) deduct wallet
    await conn.query(
      "UPDATE users SET user_wallet_balance = user_wallet_balance - ? WHERE user_id = ?",
      [pkgPrice, user_id]
    );

    // 2) insert payment (keep SAME columns you already use)
    await conn.query(
      `INSERT INTO packages_payments (payment_date, package_name, package_price, user_id)
       VALUES (NOW(), ?, ?, ?)`,
      [pkgName, pkgPrice, user_id]
    );

    // 3) update users subscription flags (authoritative for current plan)
    await conn.query(
      `UPDATE users
          SET user_subscribed = '1',
              user_package = ?,
              user_subscription_date = NOW(),
              user_boosted_posts = 0,
              user_boosted_pages = 0
        WHERE user_id = ?`,
      [pkg.package_id, user_id]
    );

    await conn.commit();

    const { awards } = await awardAffiliateCommissions(db, Number(user_id), Number(pkgPrice));

    return res.json({ status: true, message: "Package purchased successfully" });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("buy package failed:", err);
    return res.status(500).json({ status: false, message: "Internal server error" });
  } finally {
    if (conn) conn.release();
  }
});


// ================== GET /users/search  (VIP search user by username) ==================
router.get("/users/search", ensureAuth, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (q.length < 2) {
      return res.json({ status: true, data: [] });
    }

    const [rows] = await db.query(
      `
        SELECT 
          user_id,
          user_name,
          user_firstname,
          user_lastname
        FROM users
        WHERE user_name LIKE ?
        ORDER BY user_name ASC
        LIMIT 10
      `,
      [`%${q}%`]
    );

    const data = rows.map(function (u) {
      return {
        id: u.user_id,
        user_name: u.user_name,
        firstName: u.user_firstname,
        lastName: u.user_lastname,
      };
    });

    return res.json({ status: true, data: data });
  } catch (err) {
    console.error("Error searching users:", err);
    return res.status(500).json({ status: false, message: "Internal server error" });
  }
});


// ================== POST /buypackage/for-user  (VIP buys for others) ==================
router.post("/buypackage/for-user", ensureAuth, async (req, res) => {
  const { package_id, target_user_id } = req.body;
  const buyer_id = req.user.userId;

  if (!package_id || !target_user_id) {
    return res.status(200).json({
      status: false,
      message: "Missing package_id or target_user_id",
    });
  }

  let conn;
  try {
    // Check buyer is VIP (here: any subscribed user can buy; adjust if you have specific VIP package)
    const [[buyer]] = await db.query(
      "SELECT user_subscribed, user_package FROM users WHERE user_id = ? LIMIT 1",
      [buyer_id]
    );
    if (
      !buyer ||
      !(
        buyer.user_subscribed === 1 ||
        buyer.user_subscribed === "1"
      )
    ) {
      return res.status(403).json({
        status: false,
        message: "Only VIP users can buy for others",
      });
    }

    // Lookup package
    const [[pkg]] = await db.query(
      "SELECT package_id, name, price FROM packages WHERE package_id = ? LIMIT 1",
      [package_id]
    );
    if (!pkg) {
      return res.status(200).json({ status: false, message: "Package not found" });
    }

    const pkgPrice = parseFloat(pkg.price ?? 0) || 0;
    const pkgName  = String(pkg.name);

    // Buyer wallet balance
    const [[buyerRow]] = await db.query(
      "SELECT user_wallet_balance FROM users WHERE user_id = ?",
      [buyer_id]
    );
    if (!buyerRow) {
      return res.status(200).json({ status: false, message: "Buyer not found" });
    }
    const buyerBalance = parseFloat(buyerRow.user_wallet_balance ?? 0);
    if (buyerBalance < pkgPrice) {
      return res.status(200).json({
        status: false,
        message: "Insufficient balance",
      });
    }

    // Target user exists?
    const [[target]] = await db.query(
      "SELECT user_id FROM users WHERE user_id = ? LIMIT 1",
      [target_user_id]
    );
    if (!target) {
      return res.status(200).json({
        status: false,
        message: "Target user not found",
      });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) deduct wallet of buyer
    await conn.query(
      "UPDATE users SET user_wallet_balance = user_wallet_balance - ? WHERE user_id = ?",
      [pkgPrice, buyer_id]
    );

    // 2) insert payment row for target user
    await conn.query(
      `INSERT INTO packages_payments (payment_date, package_name, package_price, user_id)
       VALUES (NOW(), ?, ?, ?)`,
      [pkgName, pkgPrice, target_user_id]
    );

    // 3) update target user's subscription flags
    await conn.query(
      `UPDATE users
          SET user_subscribed = '1',
              user_package = ?,
              user_subscription_date = NOW(),
              user_boosted_posts = 0,
              user_boosted_pages = 0
        WHERE user_id = ?`,
      [pkg.package_id, target_user_id]
    );

    await conn.commit();

    try {
      await awardAffiliateCommissions(db, Number(target_user_id), Number(pkgPrice));
    } catch (e) {
      console.error("Affiliate award (for user) failed:", e);
    }

    return res.json({
      status: true,
      message: "Package purchased for user successfully",
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("buy package for user failed:", err);
    return res.status(500).json({ status: false, message: "Internal server error" });
  } finally {
    if (conn) conn.release();
  }
});


module.exports = router;
