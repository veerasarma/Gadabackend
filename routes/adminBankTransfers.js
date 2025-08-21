// routes/adminBankTransfers.js
const express = require("express");
const pool = require("../config/db");
const { ensureAuth, requireRole } = require("../middlewares/auth");

const router = express.Router();
router.use(ensureAuth, requireRole("admin"));

// GET /api/admin/bank-transfers
// router.get("/", async (req, res) => {
//   try {
//     const { status = "all", search = "", page = 1, limit = 10 } = req.query;
//     const offset = (Number(page) - 1) * Number(limit);

//     let where = "1=1";
//     const values = [];

//     // Filter by status (success = 1, failed = -1, pending = 0 maybe)
//     if (status !== "all") {
//       where += " AND status = ?";
//       values.push(status);
//     }

//     // Search by user_id or handle
//     if (search) {
//       where += " AND (user_id LIKE ? OR handle LIKE ?)";
//       values.push(`%${search}%`, `%${search}%`);
//     }

//     // Count
//     const [[{ count }]] = await pool.query(
//       `SELECT COUNT(*) as count FROM bank_transfers WHERE ${where}`,
//       values
//     );

//     // Rows
//     const [items] = await pool.query(
//       `SELECT * FROM bank_transfers WHERE ${where}
//        ORDER BY time DESC
//        LIMIT ? OFFSET ?`,
//       [...values, Number(limit), offset]
//     );

//     const totalPages = Math.ceil(count / Number(limit));

//     res.json({
//       items,
//       total: count,
//       totalPages,
//       hasPrev: Number(page) > 1,
//       hasNext: Number(page) < totalPages,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: "Failed to load bank transfers" });
//   }
// });

router.get("/", async (req, res) => {
  try {
    const { status = "all", search = "", page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = "1=1";
    const values = [];

    // Filter by status (success = 1, failed = -1, pending = 0 maybe)
    if (status !== "all") {
      where += " AND bt.status = ?";
      values.push(status);
    }

    // Search by user_id or handle or username
    if (search) {
      where +=
        " AND (bt.user_id LIKE ? OR bt.handle LIKE ? OR u.user_name LIKE ?)";
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Count (join with users for search)
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) as count
       FROM bank_transfers bt
       LEFT JOIN users u ON bt.user_id = u.user_id
       WHERE ${where}`,
      values
    );

    // Rows with username included
    const [items] = await pool.query(
      `SELECT bt.*, u.user_name
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

router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // "accept" | "decline" | "pending"

    let newStatus;
    if (action === "accept") newStatus = 1; // success
    else if (action === "decline") newStatus = -1; // failed
    else if (action === "pending") newStatus = 0; // pending
    else return res.status(400).json({ message: "Invalid action" });

    const [result] = await pool.query(
      `UPDATE bank_transfers SET status=? WHERE transfer_id=?`,
      [newStatus, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    res.json({ success: true, message: "Status updated", status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update transfer status" });
  }
});

module.exports = router;
