// routes/adminBankTransfers.js
const express = require("express");
const pool = require("../config/db");
const { ensureAuth, requireRole } = require("../middlewares/auth");

const router = express.Router();

router.use(ensureAuth, requireRole("admin"));

// GET /api/admin/bank-transfers - Full status filtering
router.get("/", async (req, res) => {
  try {
    const { status = "all", search = "", page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    let where = "1=1";
    const values = [];

    // Filter by status (1=success, -1=failed, 0=pending)
    if (status !== "all") {
      where += " AND bt.status = ?";
      values.push(status);
    }

    // Search by user_id, handle, or username
    if (search) {
      where += " AND (bt.user_id LIKE ? OR bt.handle LIKE ? OR u.user_name LIKE ?)";
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Count total (with JOIN for search)
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) as count
       FROM bank_transfers bt
       LEFT JOIN users u ON bt.user_id = u.user_id
       WHERE ${where}`,
      values
    );

    // Fetch rows with user details
    const [items] = await pool.query(
      `SELECT bt.*, u.user_name as username
       FROM bank_transfers bt
       LEFT JOIN users u ON bt.user_id = u.user_id
       WHERE ${where}
       ORDER BY bt.time DESC
       LIMIT ? OFFSET ?`,
      [...values, Number(limit), offset]
    );

    const totalPages = Math.ceil(count / Number(limit));

    res.json({
      items,
      total: count,
      totalPages,
      hasPrev: Number(page) > 1,
      hasNext: Number(page) < totalPages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load bank transfers" });
  }
});

// PUT /api/admin/bank-transfers/:id/status - Update status
router.put("/:id/status", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { action } = req.body; // "accept" | "decline" | "pending"

    let newStatus;
    if (action === "accept") newStatus = 1; // success
    else if (action === "decline") newStatus = -1; // failed
    else if (action === "pending") newStatus = 0; // pending
    else return res.status(400).json({ message: "Invalid action" });

    // Start transaction
    await conn.beginTransaction();

    // 1. Get transfer details and update status
    const [transferRows] = await conn.query(
      `SELECT * FROM bank_transfers WHERE transfer_id=?`,
      [id]
    );

    if (transferRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Transfer not found" });
    }

    const transfer = transferRows[0];
    const { user_id, price, handle } = transfer;

    const [result] = await conn.query(
      `UPDATE bank_transfers SET status=? WHERE transfer_id=?`,
      [newStatus, id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Failed to update transfer" });
    }

    // If accept, update wallet + logs
    if (action === "accept") {
      // Update user balance
      await conn.query(
        `UPDATE users SET user_wallet_balance = user_wallet_balance + ? WHERE user_id=?`,
        [price, user_id]
      );

      // Insert wallet transaction (avoid duplicate)
      const reference = `banktransfer_${id}`;
      const [exists] = await conn.query(
        `SELECT transaction_id FROM wallet_transactions WHERE reference=?`,
        [reference]
      );

      if (exists.length === 0) {
        await conn.query(
          `INSERT INTO wallet_transactions
           (user_id, node_type, node_id, amount, reference, type, date)
           VALUES (?, 'recharge', ?, ?, ?, 'in', NOW())`,
          [user_id, id, price, reference]
        );
      }

      // Insert payment log
      await conn.query(
        `INSERT INTO log_payments (user_id, method, handle, amount, time)
         VALUES (?, 'bank_transfer', ?, ?, NOW())`,
        [user_id, handle || "wallet", price]
      );
    }

    // Commit transaction
    await conn.commit();
    res.json({
      success: true,
      message: "Status updated",
      status: newStatus,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Failed to update transfer status" });
  } finally {
    conn.release();
  }
});

module.exports = router;
