// routes/media.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto = require('crypto');
const { ensureAuth } = require('../middlewares/auth');


const router = express.Router();

// 1) ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

function bucketFor(file) {
  return file.mimetype?.startsWith('video/') ? 'videos' : 'photos';
}


// 2) configure storage with absolute paths
const storage = multer.diskStorage({
  // destination: (req, file, cb) => {
  //   cb(null, UPLOADS_DIR);
  // },
  // filename: (req, file, cb) => {
  //   // sanitize filename, avoid collisions
  //   const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\.-]/g, '');
  //   cb(null, `${Date.now()}-${safeName}`);
  // }

  destination: (req, file, cb) => {
    const bucket = bucketFor(file);
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dir = path.join(process.cwd(), 'uploads', bucket, year, month);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const base = (path.basename(file.originalname, ext) || 'file')
      .replace(/[^\w-]+/g, '_')
      .slice(0, 60);
    const hash = crypto.randomBytes(6).toString('hex');
    cb(null, `${base}_${Date.now()}_${hash}${ext}`);
  },
});

// 3) filter file types if needed
function fileFilter(req, file, cb) {
  // e.g. only allow images + videos
  const allowed = /jpeg|jpg|png|gif|mp4|webm|ogg/;
  if (allowed.test(path.extname(file.originalname).toLowerCase())) {
    cb(null, true);
  } else {
    cb(new Error('Only images and videos allowed'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024   // max 200 MB per file
  }
});
// 4) route with error handling
router.post('/upload', ensureAuth, (req, res) => {
  try {
    // invoke multer for this route
    upload.array('files', 5)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        return res.status(400).json({ error: err.message });
      } else if (err) {
        console.error('Unknown upload error:', err);
        return res.status(500).json({ error: 'Upload failed' });
      }

      try {
        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) {
          return res.status(400).json({ error: 'No files received by Multer' });
        }

        // build URLs safely (works when using diskStorage with f.path)
        const urls = files.map((f) => {
          if (!f.path) {
            // If using memoryStorage, you won't have f.path; adjust to your setup.
            // e.g., return `/uploads/${f.filename}`;
            throw new Error('Uploaded file has no path (check storage engine).');
          }
          const rel = path.relative(process.cwd(), f.path).replace(/\\/g, '/');
          return rel.startsWith('/') ? rel : `/${rel}`;
        });

        return res.json({ urls });
      } catch (handlerErr) {
        console.error('Post-upload processing error:', handlerErr);
        return res.status(500).json({ error: 'Failed to process uploaded files' });
      }
    });
  } catch (outerErr) {
    console.error('Unexpected upload route error:', outerErr);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;