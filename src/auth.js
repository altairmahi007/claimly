import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set: using a random one (everyone is logged out on restart).');
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function makeSession(userId) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(value) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = sign(`${id}.${exp}`);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(id);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const newToken = () => crypto.randomBytes(24).toString('base64url');
