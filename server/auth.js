const jwt = require('jsonwebtoken');

// JWT_SECRET MUST be set on any deployed host. A weak/known secret lets anyone
// forge a Bearer token for any userId (full account + admin impersonation), so
// we fail fast at boot rather than silently signing with a committed default.
const IS_DEPLOYED = process.env.NODE_ENV === 'production'
  || !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RENDER);
const SECRET = process.env.JWT_SECRET || (
  IS_DEPLOYED
    ? (() => { throw new Error('JWT_SECRET is required on deployed hosts — refusing to start with an insecure default.'); })()
    : 'screenrec-dev-secret-change-in-prod'
);

function signToken(userId) {
  return jwt.sign({ userId }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// T-1302: an optional resolver for opaque v1 session tokens (`vs_…`). When the
// v1 API is mounted the server installs one; without it this middleware is
// byte-for-byte the legacy JWT check. A resolved session sets the SAME
// `req.userId` (the legacy id) the 59 legacy routes read, plus `req.pgUserId`
// and `req.sessionId` for the v1 routers — one identity, two stores.
let sessionResolver = null;
function configureSessionAuth({ resolve } = {}) { sessionResolver = typeof resolve === 'function' ? resolve : null; }
const isSessionToken = (t) => typeof t === 'string' && t.startsWith('vs_');

// Express middleware — attaches req.userId or returns 401
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = header.slice(7);
  if (sessionResolver && isSessionToken(token)) {
    Promise.resolve(sessionResolver(token)).then((s) => {
      if (!s) return res.status(401).json({ error: 'Invalid or expired token' });
      req.userId = s.legacyUserId;
      req.pgUserId = s.pgUserId;
      req.sessionId = s.sessionId;
      req.authKind = 'session';
      next();
    }).catch(() => res.status(401).json({ error: 'Invalid or expired token' }));
    return;
  }
  try {
    const { userId } = verifyToken(token);
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signToken, verifyToken, requireAuth, configureSessionAuth };
