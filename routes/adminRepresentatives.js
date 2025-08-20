const express = require("express");
const pool = require("../config/db");
const { ensureAuth, requireRole } = require("../middlewares/auth");

const router = express.Router();
router.use(ensureAuth, requireRole("admin"));

// GET /api/admin/representatives
router.get("/", async (req, res) => {
  try {
    const { status = "all", search = "", page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = "1=1";
    const values = [];

    if (status !== "all") {
      where += " AND status = ?";
      values.push(status);
    }

    if (search) {
      where +=
        " AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR username LIKE ?)";
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Count
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) as count FROM representatives WHERE ${where}`,
      values
    );

    // Rows
    const [items] = await pool.query(
      `SELECT * FROM representatives WHERE ${where}
       ORDER BY created_at DESC
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
    res.status(500).json({ message: "Failed to load representatives" });
  }
});

// PUT /api/admin/representatives/:id/status
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    console.log("req.body status ==>>", action, id);

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ message: "Invalid action" });
    }

    const newStatus = action === "accept" ? "approved" : "rejected";
    console.log("newStatus ==>>", newStatus);

    const [result] = await pool.query(
      `UPDATE representatives SET status = ? WHERE id = ?`,
      [newStatus, id]
    );
    console.log("result ==>>", result);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Representative not found" });
    }

    res.json({ status: true, message: `Representative ${newStatus}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update status" });
  }
});

module.exports = router;
