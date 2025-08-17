const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { ensureAuth, requireRole } = require('../middlewares/auth');
const { getAllSettings, getSettings, setSettings, KEYS } = require('../services/settingsService');

const router = express.Router();

// Everything here requires admin
router.use(ensureAuth, requireRole('admin'));

// GET /api/admin/settings  -> all sections (with secrets masked)
router.get('/', async (req, res, next) => {
  try {
    const all = await getAllSettings();

    // Mask secrets if you store them here (recommended: keep secrets in env)
    if (all.email?.smtpPassword) {
      all.email.smtpPassword = '********';
    }
    res.json(all);
  } catch (e) { next(e); }
});

// GET /api/admin/settings/:section
router.get('/:section', async (req, res, next) => {
  try {
    const { section } = req.params;
    if (!KEYS.includes(section)) return res.status(404).json({ error: 'Unknown section' });
    const current = await getSettings(section);
    if (section === 'email' && current.smtpPassword) current.smtpPassword = '********';
    res.json(current);
  } catch (e) { next(e); }
});

// PUT /api/admin/settings/:section
router.put('/:section',
  param('section').custom(v => KEYS.includes(v)),
  // Basic validation per section; adjust as needed
  body('*').custom(() => true), // allow object
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { section } = req.params;
      const payload = req.body || {};

      // Normalize/mask behavior
      if (section === 'email') {
        // if smtpPassword = "********", keep old one
        const current = await getSettings('email');
        if (payload.smtpPassword === '********') {
          payload.smtpPassword = current.smtpPassword; // keep
        }
      }

      await setSettings(section, payload);
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

module.exports = router;
