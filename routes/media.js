// // routes/media.js
// const express = require('express');
// const multer  = require('multer');
// const path    = require('path');
// const fs      = require('fs');
// const crypto = require('crypto');
// const { ensureAuth } = require('../middlewares/auth');


// const router = express.Router();

// // 1) ensure uploads directory exists
// const UPLOADS_DIR = path.join(__dirname, '../uploads');
// if (!fs.existsSync(UPLOADS_DIR)) {
//   fs.mkdirSync(UPLOADS_DIR);
// }

// function bucketFor(file) {
//   return file.mimetype?.startsWith('video/') ? 'videos' : 'photos';
// }


// // 2) configure storage with absolute paths
// const storage = multer.diskStorage({
//   // destination: (req, file, cb) => {
//   //   cb(null, UPLOADS_DIR);
//   // },
//   // filename: (req, file, cb) => {
//   //   // sanitize filename, avoid collisions
//   //   const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\.-]/g, '');
//   //   cb(null, `${Date.now()}-${safeName}`);
//   // }

//   destination: (req, file, cb) => {
//     const bucket = bucketFor(file);
//     const now = new Date();
//     const year = String(now.getFullYear());
//     const month = String(now.getMonth() + 1).padStart(2, '0');
//     const dir = path.join(process.cwd(), 'uploads', bucket, year, month);
//     fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
//   },
//   filename: (req, file, cb) => {
//     const ext = (path.extname(file.originalname) || '').toLowerCase();
//     const base = (path.basename(file.originalname, ext) || 'file')
//       .replace(/[^\w-]+/g, '_')
//       .slice(0, 60);
//     const hash = crypto.randomBytes(6).toString('hex');
//     cb(null, `${base}_${Date.now()}_${hash}${ext}`);
//   },
// });

// // 3) filter file types if needed
// function fileFilter(req, file, cb) {
//   // e.g. only allow images + videos
//   const allowed = /jpeg|jpg|png|gif|mp4|webm|ogg/;
//   if (allowed.test(path.extname(file.originalname).toLowerCase())) {
//     cb(null, true);
//   } else {
//     cb(new Error('Only images and videos allowed'), false);
//   }
// }

// const upload = multer({
//   storage,
//   fileFilter,
//   limits: {
//     fileSize: 200 * 1024 * 1024   // max 200 MB per file
//   }
// });
// // 4) route with error handling
// router.post('/upload', ensureAuth, (req, res) => {
//   try {
//     // invoke multer for this route
//     upload.array('files', 5)(req, res, (err) => {
//       if (err instanceof multer.MulterError) {
//         console.error('Multer error:', err);
//         return res.status(400).json({ error: err.message });
//       } else if (err) {
//         console.error('Unknown upload error:', err);
//         return res.status(500).json({ error: 'Upload failed' });
//       }

//       try {
//         const files = Array.isArray(req.files) ? req.files : [];
//         if (!files.length) {
//           return res.status(400).json({ error: 'No files received by Multer' });
//         }

//         // build URLs safely (works when using diskStorage with f.path)
//         const urls = files.map((f) => {
//           if (!f.path) {
//             // If using memoryStorage, you won't have f.path; adjust to your setup.
//             // e.g., return `/uploads/${f.filename}`;
//             throw new Error('Uploaded file has no path (check storage engine).');
//           }
//           const rel = path.relative(process.cwd(), f.path).replace(/\\/g, '/');
//           return rel.startsWith('/') ? rel : `/${rel}`;
//         });

//         return res.json({ urls });
//       } catch (handlerErr) {
//         console.error('Post-upload processing error:', handlerErr);
//         return res.status(500).json({ error: 'Failed to process uploaded files' });
//       }
//     });
//   } catch (outerErr) {
//     console.error('Unexpected upload route error:', outerErr);
//     return res.status(500).json({ error: 'Unexpected server error' });
//   }
// });

// module.exports = router;

// routes/media.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { ensureAuth } = require('../middlewares/auth');

const router = express.Router();

// ------------- R2 Client Setup -------------
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

// ------------- Helper Functions -------------
function bucketFor(file) {
  return file.mimetype?.startsWith('video/') ? 'videos' : 'photos';
}

function generateFilename(originalname) {
  const ext = (path.extname(originalname) || '').toLowerCase();
  const base = (path.basename(originalname, ext) || 'file')
    .replace(/[^\w-]+/g, '_')
    .slice(0, 60);
  const hash = crypto.randomBytes(6).toString('hex');
  return `${base}_${Date.now()}_${hash}${ext}`;
}

function getRelativePath(file) {
  const bucket = bucketFor(file);
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const filename = generateFilename(file.originalname);
  
  // POSIX path: uploads/bucket/year/month/filename
  return `uploads/${bucket}/${year}/${month}/${filename}`;
}

// ------------- Multer Configuration -------------
// Use memory storage since we're uploading to R2
const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  const allowed = /jpeg|jpg|png|gif|mp4|webm|ogg|webp|avif|mov|avi/;
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only images and videos allowed'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024, // max 200 MB per file
  },
});

// ------------- Upload to R2 Function -------------
async function uploadToR2(file) {
  const relativePath = getRelativePath(file);
  
  console.log(`📤 Uploading to R2: ${relativePath}`);
  console.log(`   Size: ${(file.buffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Type: ${file.mimetype}`);

  const putCmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: relativePath,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  const startTime = Date.now();
  const result = await r2Client.send(putCmd);
  const uploadTime = Date.now() - startTime;

  console.log(`✅ Uploaded in ${uploadTime}ms, ETag: ${result.ETag}`);

  return {
    relativePath,
    publicUrl: R2_PUBLIC_BASE_URL ? `${R2_PUBLIC_BASE_URL}/${relativePath}` : null,
    etag: result.ETag,
  };
}

// ------------- Upload Route -------------
router.post('/upload', ensureAuth, (req, res) => {
  console.log('\n🚀 /upload route hit');
  
  upload.array('files', 5)(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      console.error('❌ Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    } else if (err) {
      console.error('❌ Upload error:', err.message);
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }

    try {
      const files = Array.isArray(req.files) ? req.files : [];
      
      if (!files.length) {
        console.log('⚠️  No files received');
        return res.status(400).json({ error: 'No files received' });
      }

      console.log(`📦 Processing ${files.length} file(s)`);

      // Upload all files to R2 in parallel
      const uploadPromises = files.map(file => uploadToR2(file));
      const results = await Promise.all(uploadPromises);

      // Return URLs in the same format as before
      const urls = results.map(r => `/${r.relativePath}`);
      
      // Also return public URLs if available
      const publicUrls = results
        .filter(r => r.publicUrl)
        .map(r => r.publicUrl);

      console.log(`✅ Successfully uploaded ${urls.length} file(s)\n`);

      return res.json({
        urls,           // relative paths like /uploads/photos/2026/02/file_123.jpg
        publicUrls,     // full R2 URLs if R2_PUBLIC_BASE_URL is set
      });

    } catch (uploadErr) {
      console.error('❌ R2 upload error:', uploadErr);
      return res.status(500).json({
        error: 'Failed to upload to R2',
        details: uploadErr.message,
      });
    }
  });
});

module.exports = router;
