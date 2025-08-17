const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set! Requests will fail.');
}

// function ensureAuth(req, res, next) {
//   // 1) Get token from header
//   const authHeader = req.headers.authorization || '';
//   const match = authHeader.match(/^Bearer (.+)$/);
//   if (!match) {
//     return res.status(401).json({ error: 'Missing or invalid Authorization header' });
//   }
//   const token = match[1];

//   // 2) Verify
//   jwt.verify(token, JWT_SECRET, (err, payload) => {
//     if (err) {
//       return res.status(401).json({ error: 'Invalid or expired token' });
//     }

//     // 3) Attach user info to request
//     //    payload should contain at least { id: ..., username: ... }
//     req.user = payload;
//     next();
//   });
// }

function ensureAuth(req, res, next) {
  const hdr = req.get('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { userId: payload.userId, email: payload.email, roles: payload.roles || [] };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user?.roles?.some(r => allowed.includes(r))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { ensureAuth, requireRole };


// module.exports = { ensureAuth };