require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-in-production';
const MAX_ATTEMPTS = 3;
const LOCK_MS = 15 * 60 * 1000;

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const ASSETS_DIR = path.join(ROOT, 'assets');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

if (!ADMIN_PASSWORD) {
  console.error('ERROR: Set ADMIN_PASSWORD in your .env file before starting.');
  process.exit(1);
}

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const loginAttempts = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { eventPoster: 'assets/open-mic-poster.jpeg', updatedAt: null };
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function isLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginAttempts.delete(ip);
  }
  return false;
}

function recordFailedAttempt(ip) {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_MS;
  }
  loginAttempts.set(ip, record);
  return record;
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

function remainingAttempts(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return MAX_ATTEMPTS;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return 0;
  return Math.max(0, MAX_ATTEMPTS - record.count);
}

function lockMinutesLeft(ip) {
  const record = loginAttempts.get(ip);
  if (!record?.lockedUntil) return 0;
  return Math.ceil((record.lockedUntil - Date.now()) / 60000);
}

function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `poster-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
  },
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    name: 'petrichor_admin',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 4 * 60 * 60 * 1000,
    },
  })
);

app.get('/api/config', (_req, res) => {
  const config = readConfig();
  const poster = config.eventPoster || 'assets/open-mic-poster.jpeg';
  const version = config.updatedAt || '';
  res.json({
    eventPoster: version ? `${poster}?v=${version}` : poster,
    updatedAt: config.updatedAt,
  });
});

app.get('/api/admin/status', (req, res) => {
  const ip = getClientIp(req);
  res.json({
    authenticated: Boolean(req.session?.isAdmin),
    locked: isLocked(ip),
    remainingAttempts: remainingAttempts(ip),
    lockMinutesLeft: lockMinutesLeft(ip),
    currentPoster: readConfig().eventPoster,
  });
});

app.post('/api/admin/login', (req, res) => {
  const ip = getClientIp(req);
  const { password } = req.body || {};

  if (isLocked(ip)) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${lockMinutesLeft(ip)} minute(s).`,
      locked: true,
      lockMinutesLeft: lockMinutesLeft(ip),
    });
  }

  if (!password || !safeCompare(String(password), ADMIN_PASSWORD)) {
    const record = recordFailedAttempt(ip);
    const left = remainingAttempts(ip);
    if (record.lockedUntil && Date.now() < record.lockedUntil) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${lockMinutesLeft(ip)} minute(s).`,
        locked: true,
        lockMinutesLeft: lockMinutesLeft(ip),
      });
    }
    return res.status(401).json({
      error: `Invalid password. ${left} attempt(s) remaining.`,
      remainingAttempts: left,
    });
  }

  clearAttempts(ip);
  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.post('/api/admin/upload-poster', requireAdmin, upload.single('poster'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpeg';
  const allowedExt = ['.jpg', '.jpeg', '.png', '.webp'];
  if (!allowedExt.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Invalid file type' });
  }

  const destName = `event-poster${ext === '.jpg' ? '.jpeg' : ext}`;
  const destPath = path.join(ASSETS_DIR, destName);
  const publicPath = `assets/${destName}`;

  fs.renameSync(req.file.path, destPath);

  const config = {
    eventPoster: publicPath,
    updatedAt: Date.now(),
  };
  writeConfig(config);

  res.json({
    success: true,
    eventPoster: `${publicPath}?v=${config.updatedAt}`,
    updatedAt: config.updatedAt,
  });
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 8 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

app.use(express.static(ROOT, { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`Petrichor running at http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin`);
});
