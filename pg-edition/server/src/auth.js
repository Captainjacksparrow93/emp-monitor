import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { state } from './state.js';

export function signAdmin(admin) {
  return jwt.sign({ sub: admin.id, role: admin.role, name: admin.name, email: admin.email, typ: 'admin' },
    config.jwtSecret, { expiresIn: '12h' });
}

export function signDevice(device) {
  return jwt.sign({ sub: device.id, tv: device.token_version, typ: 'device' }, config.jwtSecret);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Admin auth is stateless (JWT) - no DB lookup per request. */
export function requireAdmin(req, res, next) {
  try {
    const payload = jwt.verify(bearer(req) || '', config.jwtSecret);
    if (payload.typ !== 'admin') throw new Error('wrong token type');
    req.admin = { id: payload.sub, role: payload.role, name: payload.name, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

export function requireWrite(req, res, next) {
  if (req.admin?.role !== 'admin') return res.status(403).json({ error: 'Read-only account' });
  return next();
}

/** Device auth is validated against the in-memory device cache - no DB lookup. */
export function requireDevice(req, res, next) {
  try {
    const payload = jwt.verify(bearer(req) || '', config.jwtSecret);
    if (payload.typ !== 'device') throw new Error('wrong token type');
    const device = state.devices.get(payload.sub);
    if (!device || device.token_version !== payload.tv) {
      return res.status(401).json({ error: 'Device revoked', code: 'REVOKED' });
    }
    req.device = device;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid device token', code: 'REVOKED' });
  }
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
}
