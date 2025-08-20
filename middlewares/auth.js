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

function normalizeToArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;

  if (typeof val === 'string') {
    const trimmed = val.trim();
    // If roles stored as JSON array string: '["admin","moderator"]'
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr;
      } catch (_) {}
    }
    // Fallback: 'admin' or 'admin,moderator'
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function isAllowedRole(userRolesStr, allowed) {
  const userRoles = normalizeToArray(userRolesStr).map(r => r.toLowerCase());
  const allowedArr = normalizeToArray(allowed).map(r => r.toLowerCase());

  if (allowedArr.length === 0) return true; // nothing required -> allow
  return userRoles.some(r => allowedArr.includes(r));
}

// Express middleware: ensureAuth should run before this
function requireRole(allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const rolesStr = req.user.roles || req.user.role || ''; // support either field
    if (isAllowedRole(rolesStr, allowed)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}


module.exports = { ensureAuth, requireRole };


// module.exports = { ensureAuth };