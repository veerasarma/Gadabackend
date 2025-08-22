// server/utils/upload.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

// Ensure a directory exists (sync so we can use inside multer callbacks)
function ensureDirSync(dirpath) {
  try {
    fs.mkdirSync(dirpath, { recursive: true });
  } catch (e) {
    // another process may have created it; ignore EEXIST
    if (e.code !== 'EEXIST') throw e;
  }
}

// Very safe filename generator; preserves extension
function uniqueFilename(originalName) {
  const ext = (path.extname(originalName) || '').toLowerCase();
  const stamp = Date.now().toString(36);
  const rnd = crypto.randomBytes(6).toString('hex');
  return `${stamp}-${rnd}${ext}`;
}

// Basic image MIME allow-list
const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/**
 * Returns an Express middleware that accepts **one image** (field name=field),
 * stores it under: uploads/<subdir>/<YYYY>/<MM>/<unique>.<ext>
 * and sets `req.file.relativePath` to that relative path (POSIX style).
 *
 * @param {string} field     - form field name (e.g., 'cover' or 'picture')
 * @param {string} subdir    - top-level subdir inside /uploads (e.g., 'photos', 'avatars')
 * @param {object} options   - optional { maxSizeBytes?: number, allowedMimes?: Set<string> }
 */
function uploadSingleImageToYearMonth(field, subdir = 'photos', options = {}) {
  const maxSizeBytes = Number(options.maxSizeBytes || 10 * 1024 * 1024); // 10MB default
  const allowedMimes = options.allowedMimes || IMAGE_MIMES;

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Validate MIME early for clearer errors
      if (!allowedMimes.has(file.mimetype)) {
        return cb(new Error('Only image uploads are allowed.'));
      }

      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');

      const absDir = path.join(UPLOADS_ROOT, subdir, year, month);
      ensureDirSync(absDir);
      cb(null, absDir);
    },

    filename: (req, file, cb) => {
      const name = uniqueFilename(file.originalname || 'upload');
      // Attach relativePath so route handlers can store it in DB
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');

      // Always POSIX style for URLs / DB (forward slashes)
      file.relativePath = [subdir, year, month, name].join('/');
      cb(null, name);
    },
  });

  const fileFilter = (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      return cb(new Error('Unsupported file type.'));
    }
    cb(null, true);
  };

  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: maxSizeBytes },
  }).single(field);

  // Wrap multer to normalize errors & guarantee req.file.relativePath exists
  return function uploadMiddleware(req, res, next) {
    upload(req, res, (err) => {
      if (err) {
        // Multer errors: convert to 400
        err.status = err.status || 400;
        return next(err);
      }
      // If no file provided, just continue (route can treat it as optional)
      if (!req.file) return next();
      // Ensure we always expose a normalized relativePath
      if (!req.file.relativePath) {
        // Build from destination + filename if needed
        const dest = req.file.destination.replace(UPLOADS_ROOT, '').replace(/\\/g, '/').replace(/^\/+/, '');
        req.file.relativePath = `${dest}/${req.file.filename}`;
      }
      return next();
    });
  };
}

module.exports = {
  uploadSingleImageToYearMonth,
  // export helpers in case you want to reuse
  ensureDirSync,
  uniqueFilename,
  IMAGE_MIMES,
  UPLOADS_ROOT,
};
