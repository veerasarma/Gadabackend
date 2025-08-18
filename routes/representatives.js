const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');                // mysql2/promise pool
const { ensureAuth } = require('../middlewares/auth'); // must set req.user.userId

const router = express.Router();

function mapRow(r) {
  return {
    id: Number(r.id),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    name: r.name,
    username: r.username,
    phone: r.phone,
    email: r.email,
    state: r.state,
    residentAddress: r.resident_address,
    residentialState: r.residential_state,
    proposedLocation: r.proposed_location,
    gadaChatUsername: r.gada_chat_username,
    note: r.note,
  };
}

const validators = [
  body('name').trim().isLength({ min: 2 }).withMessage('Name is required'),
  body('username')
    .trim()
    .isLength({ min: 3 })
    .matches(/^[a-z0-9._-]+$/i)
    .withMessage('Invalid username'),
  body('phone')
    .trim()
    .isLength({ min: 7, max: 20 })
    .matches(/^[+0-9 ()-]+$/)
    .withMessage('Invalid phone'),
  body('email').isEmail().withMessage('Invalid email'),
  body('state').trim().isLength({ min: 2 }).withMessage('State is required'),
  body('residentAddress')
    .trim()
    .isLength({ min: 5 })
    .withMessage('Resident address is required'),
  body('residentialState')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Residential state is required'),
  body('proposedLocation')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Proposed location is required'),
  body('gadaChatUsername')
    .trim()
    .isLength({ min: 3 })
    .matches(/^[a-z0-9._-]+$/i)
    .withMessage('Invalid gada.chat username'),
  body('note').trim().isLength({ min: 10, max: 600 }).withMessage('Note 10–600 chars'),
];

/**
 * GET /api/representatives/me
 * Returns 404 if none
 */
router.get('/me', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [rows] = await pool.query(
      `SELECT * FROM representatives WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'No application' });
    return res.json(mapRow(rows[0]));
  } catch (err) {
    console.error('[rep GET /me]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/representatives
 * Create new application (one per user)
 */
router.post('/', ensureAuth, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(422).json({ errors: errors.array() });

  const userId = req.user.userId;
  const {
    name,
    username,
    phone,
    email,
    state,
    residentAddress,
    residentialState,
    proposedLocation,
    gadaChatUsername,
    note,
  } = req.body;

  try {
    // deny if already exists
    const [exists] = await pool.query(
      `SELECT id FROM representatives WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (exists.length) {
      return res.status(409).json({ error: 'Application already exists' });
    }

    const [result] = await pool.query(
      `INSERT INTO representatives
        (user_id, name, username, phone, email, state, resident_address, residential_state,
         proposed_location, gada_chat_username, note, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      [
        userId,
        name,
        username,
        phone,
        email,
        state,
        residentAddress,
        residentialState,
        proposedLocation,
        gadaChatUsername,
        note,
      ]
    );

    const [rows] = await pool.query(
      `SELECT * FROM representatives WHERE id = ?`,
      [result.insertId]
    );
    return res.status(201).json(mapRow(rows[0]));
  } catch (err) {
    console.error('[rep POST /]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/representatives/me
 * Update the user’s application
 */
router.put('/me', ensureAuth, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(422).json({ errors: errors.array() });

  const userId = req.user.userId;
  const {
    name,
    username,
    phone,
    email,
    state,
    residentAddress,
    residentialState,
    proposedLocation,
    gadaChatUsername,
    note,
  } = req.body;

  try {
    const [rows] = await pool.query(
      `SELECT * FROM representatives WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'No application to update' });

    await pool.query(
      `UPDATE representatives
          SET name=?, username=?, phone=?, email=?, state=?, resident_address=?,
              residential_state=?, proposed_location=?, gada_chat_username=?, note=?
        WHERE user_id=?`,
      [
        name,
        username,
        phone,
        email,
        state,
        residentAddress,
        residentialState,
        proposedLocation,
        gadaChatUsername,
        note,
        userId,
      ]
    );

    const [fresh] = await pool.query(
      `SELECT * FROM representatives WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    return res.json(mapRow(fresh[0]));
  } catch (err) {
    console.error('[rep PUT /me]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router; // IMPORTANT: export the router itself
