const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db");
const authMiddleware = require("../");
// const auth = require("../middlewares/authMiddleware");
const { ensureAuth } = require("../middlewares/auth");

router.get("/", async (req, res, next) => {
  try {
    const [rows] = await db.query(`
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

    if (!rows.length) {
      return res.status(404).json({
        status: false,
        message: "No packages found",
      });
    }

    res.json({
      status: true,
      data: rows,
    });
  } catch (err) {
    console.error("Error fetching packages:", err);
    res.status(500).json({
      status: false,
      message: "Database query failed",
    });
    // next(err);
  }
});

router.post("/buypackage", ensureAuth, async (req, res) => {
  const { package_id, package_name, package_price } = req.body;
  const user_id = req.user.userId; // auth middleware should set this
  console.log("user_id-->>", user_id, "req.body", req.body);

  try {
    // 1. Get user wallet balance
    const [[user]] = await db.query(
      "SELECT user_wallet_balance FROM users WHERE user_id = ?",
      [user_id]
    );

    console.log("user finded-->>", user);

    if (!user) {
      return res.status(200).json({ status: false, message: "User not found" });
    }

    // return;

    const balance = parseFloat(user.user_wallet_balance);

    // 2. Check if balance is enough
    if (balance < package_price) {
      return res
        .status(200)
        .json({ status: false, message: "Insufficient balance" });
    }

    // 3. Deduct wallet balance
    await db.query(
      "UPDATE users SET user_wallet_balance = user_wallet_balance - ? WHERE user_id = ?",
      [package_price, user_id]
    );

    // 4. Insert into packages_payments table
    await db.query(
      `INSERT INTO packages_payments (payment_date, package_name, package_price, user_id)
       VALUES (NOW(), ?, ?, ?)`,
      [package_name, package_price, user_id]
    );

    return res.json({
      status: true,
      message: "Package purchased successfully",
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: false, message: "Internal server error" });
  }
});

module.exports = router;
