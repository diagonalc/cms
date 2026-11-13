const crypto = require('node:crypto');

/**
 * 生成 scrypt 密码哈希，格式：salt:hash（都是 hex）。
 * 为什么不存 md5：md5 太快，泄露后可以被彩虹表/暴力破解。
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** 校验密码，使用 timingSafeEqual 避免计时攻击。 */
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 随机 token：用于 session id / CSRF token。 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashPassword, verifyPassword, randomToken };
