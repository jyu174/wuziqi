'use strict';
// Server-side auth: user store (users.json), scrypt password hashing, in-memory sessions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 days

let users = {};
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
} catch (e) {
  users = {};
}

const sessions = new Map(); // token -> { username, expires }

function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function register(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_一-龥]{2,20}$/.test(username)) {
    return { error: '用户名需为2-20位字母、数字、下划线或汉字' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { error: '密码至少需要6位' };
  }
  const key = username.toLowerCase();
  if (users[key]) {
    return { error: '该用户名已被注册' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users[key] = {
    name: username,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  saveUsers();
  return { ok: true };
}

function login(username, password) {
  const bad = { error: '用户名或密码错误' };
  if (typeof username !== 'string' || typeof password !== 'string') return bad;
  const u = users[username.toLowerCase()];
  if (!u) return bad;
  const h = Buffer.from(hashPassword(password, u.salt), 'hex');
  if (!crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return bad;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: u.name, expires: Date.now() + SESSION_TTL });
  return { token, username: u.name };
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL;
  return s.username;
}

function logout(token) {
  sessions.delete(token);
}

module.exports = { register, login, verify, logout };
