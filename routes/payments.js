// routes/payments.js
const express = require("express");
const axios = require("axios");
const router = express.Router();
const { PAYSTACK_SECRET_KEY, PAYSTACK_BASE_URL } = process.env;
const { pool } = require('../config/db');
const crypto = require('crypto');
const { ensureAuth } = require('../middlewares/auth');
const path = require('path');
const fs = require('fs');
const multer = require('multer');



// ---------- helpers ----------
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function two(n) {
  return String(n).padStart(2, '0');
}

// Accept images & PDF only
const ALLOWED = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const now = new Date();
      const year = String(now.getFullYear());
      const month = two(now.getMonth() + 1);

      // absolute path where file is stored
      const abs = path.join(process.cwd(), 'uploads', 'photos', year, month);
      ensureDirSync(abs);
      cb(null, abs);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase() || '.jpg';
    const name = 'GADA_' + crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  }
});


// POST /api/payments/initialize
// body: { email, amount, metadata?: { userId, orderId, ... } }
router.post("/initialize", async (req, res, next) => {
  const { email, amount, metadata } = req.body;
  try {
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: amount * 100, // in kobo
        metadata,
        callback_url: `_BSE_URL}/payment-success`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    // return authorization URL & reference to frontend
    res.json(response.data.data);
  } catch (err) {
    next(err);
  }
});

function verifySignature(req) {
  // Paystack sends hex HMAC in this header
  const sig = req.get('x-paystack-signature') || '';

  // Ensure we hash the raw body bytes
  const bodyBuf = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body || {}));

  const computedHex = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(bodyBuf)
    .digest('hex');

  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const compBuf = Buffer.from(computedHex, 'hex');

    if (sigBuf.length !== compBuf.length) return false; // timingSafeEqual throws on length mismatch
    return crypto.timingSafeEqual(sigBuf, compBuf);
  } catch {
    return false;
  }
}

router.post('/webhook', async (req, res, next) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send('Invalid signature');
    }
  
  console.log(req.body,'detauils')
  if(req.body.event=='charge.success' && req.body.data.status == 'success')
  {
      let data = req.body.data;
      let amount = data.amount;
      let reference = data.reference;
      let user_email = data.customer.email;
      const [rows1] = await pool.promise().query(
        `SELECT 
           transaction_id
         FROM wallet_transactions
         WHERE reference = ?`,
        [reference]
      );
      if(rows1.length==0)
      {
          const [rows] = await pool.promise().query(
          `SELECT 
          user_id
          FROM users
          WHERE user_email = ?`,
          [user_email]
          );

          let user_id = rows[0].user_id;
          const sql = `
          INSERT INTO wallet_transactions
          (user_id, node_type, node_id, amount,reference, \`type\`, \`date\`)
          VALUES (?, ?, ?, ?, ?,?, NOW())
          `;
          let nodeId = 0;
          let type = 'in';
          const values = [user_id, 'recharge', nodeId, amount,reference, type];
          // Ensure no undefined sneaks in (prevents "Incorrect arguments to mysqld_stmt_execute")
          if (values.some(v => v === undefined)) {
            throw new Error(`Missing value in: ${JSON.stringify(values)}`);
          }
          const [result] = await pool.promise().execute(sql, values);
          const [r1] = await pool.promise().execute(
          `INSERT INTO log_payments
          (user_id, method, handle, amount,  time)
          VALUES (?, ?,?, ?,NOW())`,
          [user_id,'paystack','wallet',amount,]
          );

          const update = await pool.promise().query(
          'UPDATE users SET user_wallet_balance = user_wallet_balance+? WHERE user_id = ?',
          [amount, user_id]
          );

          return true;
      }
      
  }
}
catch(e)
{
  console.log(e,'error')
}
});

router.get(
  '/getsystemdetails',
  ensureAuth,
  async (req, res, next) => {
    try {
      res.json(req.system);
    } catch (err) {
      next(err);
    }
  });
router.get(
  '/transactions',
  ensureAuth,
  async (req, res, next) => {
    try {
      const userId = req.user.userId;
      const { start, end } = req.query;

      const whereClauses = ['user_id = ?'];
      const params = [userId];

      if (start) {
        whereClauses.push('created_at >= ?');
        params.push(start + ' 00:00:00');
      }
      if (end) {
        whereClauses.push('created_at <= ?');
        params.push(end + ' 23:59:59');
      }

      const sql = `
        SELECT
          transaction_id AS id,
          amount,
          node_type AS type,        -- e.g. 'replenish' | 'affiliate' | 'payment'
          date AS createdAt
        FROM wallet_transactions
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY date DESC
        LIMIT 100
      `;

      const [rows] = await pool.promise().query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/bank-transfer/receipt',
  ensureAuth,
  upload.single('receipt'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Receipt file is required' });
      }

      const userId = Number(req.user && req.user.userId);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const amount = Number(req.body.baseAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      // Build the relative path to store in DB (without the leading "uploads/")
      // e.g. "photos/2025/08/GADA_abc123.jpg"
      const uploadRoot = path.join(process.cwd(), 'uploads');
      const relFromUploads = path
        .relative(uploadRoot, req.file.path)
        .replace(/\\/g, '/'); // windows-safe slashes

      // Insert into bank_transfers
      // status: 0 (pending). handle: 'wallet' to match your "wallet top-up" use-case
      const sql = `
        INSERT INTO bank_transfers
          (user_id, handle, price, bank_receipt, time, status)
        VALUES (?, 'wallet', ?, ?, NOW(), 0)
      `;

      const [result] = await pool.promise().query(sql, [
        userId,
        amount,
        relFromUploads, // store "photos/YYYY/MM/..."
      ]);

      const transferId = result.insertId;

      // Optional: include back useful data for UI
      return res.status(201).json({
        ok: true,
        transferId,
        userId,
        price: amount,
        bank_receipt: relFromUploads,
        fileUrl: `/uploads/${relFromUploads}` // if you serve /uploads statically (see below)
      });
    } catch (err) {
      console.error('[POST /bank-transfer/receipt] ', err);
      return res.status(500).json({ error: 'Failed to submit bank transfer receipt' });
    }
  }
);

module.exports = router;

// {
//        event: 'charge.success',
//        data: {
//          id: 5235719844,
//          domain: 'test',
//          status: 'success',
//          reference: 'ma6vv8h94m',
//          amount: 10000,
//          message: null,
//          gateway_response: 'Successful',
//          paid_at: '2025-08-13T19:07:18.000Z',
//          created_at: '2025-08-13T19:07:11.000Z',
//          channel: 'card',
//          currency: 'NGN',
//          ip_address: '106.195.40.53',
//          metadata: { userId: '9008', referrer: 'https://gadachat.pages.dev/' },
//          fees_breakdown: null,
//          log: null,
//          fees: 150,
//          fees_split: null,
//          authorization: {
//            authorization_code: 'AUTH_1475426igs',
//            bin: '408408',
//            last4: '4081',
//            exp_month: '12',
//            exp_year: '2030',
//            channel: 'card',
//            card_type: 'visa ',
//            bank: 'TEST BANK',
//            country_code: 'NG',
//            brand: 'visa',
//            reusable: true,
//            signature: 'SIG_1uWkcPXQ7rscUC5bB195',
//            account_name: null,
//            receiver_bank_account_number: null,
//            receiver_bank: null
//          },
//          customer: {
//            id: 299052728,
//            first_name: null,
//            last_name: null,
//            email: 'testuser@yopmail.com',
//            customer_code: 'CUS_3msupageoo0ew3b',
//            phone: null,
//            metadata: null,
//            risk_action: 'default',
//            international_format_phone: null
//          },
//          plan: {},
//          subaccount: {},
//          split: {},
//          order_id: null,
//          paidAt: '2025-08-13T19:07:18.000Z',
//          requested_amount: 10000,
//          pos_transaction_data: null,
//          source: {
//            type: 'api',
//            source: 'merchant_api',
//            entry_point: 'transaction_initialize',
//            identifier: null
//          }
//      }
// ̵}
