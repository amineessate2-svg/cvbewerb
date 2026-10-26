/**
 * Auto-CV Bulk Sender — Redesigned with Email/Password Authentication
 *
 * NEW FEATURES:
 * - Email & Password based registration (replaces phone-only auth)
 * - Admin approval required before users can access the system
 * - Free trial automatically activated after admin approval
 * - Domain selection feature for users
 * - Hidden admin login (special email automatically routes to admin panel)
 * - Manual email addition by admin
 */
import express from 'express';
import helmet from 'helmet';
import sanitizeHtml from 'sanitize-html';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { searchJobPlatforms } from './scraper/platforms_service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const CV_DIR = path.join(DATA_DIR, 'cv');
const CV_META = path.join(DATA_DIR, 'cv.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const APPLICATIONS_PATH = path.join(DATA_DIR, 'applications.json');

async function getApplicationsStore() {
  try {
    const raw = await fsp.readFile(APPLICATIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function saveApplicationsStore(data) {
  try {
    await fsp.writeFile(APPLICATIONS_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error saving applications:', e.message);
    return false;
  }
}

async function recordApplicationSent({ userId, to, company, position, offerUrl, platform, notes }) {
  try {
    const apps = await getApplicationsStore();
    const cleanComp = cleanGermanCompanyName(company || to.split('@')[1]?.split('.')[0] || 'Unternehmen', to);
    const now = new Date().toISOString();
    const uId = userId || 'admin';
    
    const existingIndex = apps.findIndex(a => 
      (a.userId === uId || (!a.userId && uId === 'admin')) &&
      (a.email?.toLowerCase() === (to || '').toLowerCase() || 
       (company && a.company?.toLowerCase() === company.toLowerCase()))
    );

    if (existingIndex >= 0) {
      apps[existingIndex].status = 'Gesendet';
      apps[existingIndex].appliedDate = now;
      if (!apps[existingIndex].history) apps[existingIndex].history = [];
      apps[existingIndex].history.push({
        status: 'Gesendet',
        date: now,
        notes: notes || 'Nouvelle candidature envoyée via Auto-CV Sender'
      });
    } else {
      apps.unshift({
        id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        userId: uId,
        company: company || cleanComp,
        cleanCompany: cleanComp,
        position: position || 'Ausbildung / Bewerbung',
        city: 'Deutschland',
        email: (to || '').trim(),
        phone: '',
        platform: platform || 'Direktbewerbung (Email)',
        offerUrl: offerUrl || '',
        status: 'Gesendet',
        appliedDate: now,
        interviewDate: '',
        notes: notes || 'Candidature envoyée automatiquement via Auto-CV Sender',
        history: [
          { status: 'Gesendet', date: now, notes: 'Candidature envoyée par email' }
        ]
      });
    }
    await saveApplicationsStore(apps);
  } catch (err) {
    console.error('Failed to auto-record application:', err.message);
  }
}

const MAX_CV_BYTES = 10 * 1024 * 1024;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
const CV_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

fs.mkdirSync(CV_DIR, { recursive: true });
dotenv.config({ path: ENV_PATH, quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Hidden Admin Credentials (special email that auto-routes to admin)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'amineessate1@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Amine@0106';

/* ============================ Gmail / SMTP (Per-User Architecture) ============================ */

const userTransporters = new Map(); // key: userId or 'admin' -> { transporter, email }
let adminGmail = { connected: false, email: '', error: 'Not configured yet' };

function readEnvCreds() {
  dotenv.config({ path: ENV_PATH, override: true, quiet: true });
  return {
    user: (process.env.GMAIL_USER || '').trim(),
    pass: (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '')
  };
}

function friendlySmtpError(e) {
  const msg = (e && e.message) || String(e);
  if (e?.code === 'EAUTH' || /535|Username and Password not accepted|BadCredentials/i.test(msg)) {
    return 'Gmail a rejeté les identifiants. Vérifiez que la validation en 2 étapes est activée et utilisez un mot de passe d\'application de 16 caractères valide.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ESOCKET/i.test(e?.code || msg)) {
    return 'Impossible de joindre smtp.gmail.com (problème réseau/pare-feu): ' + msg;
  }
  return msg;
}

async function createAndVerifyTransporter(user, pass) {
  if (!user || !pass) {
    return { ok: false, error: 'Email et mot de passe d\'application 16 caractères requis.' };
  }
  const cleanUser = String(user).trim();
  const cleanPass = String(pass).replace(/\s+/g, '');
  if (!EMAIL_RE.test(cleanUser)) {
    return { ok: false, error: 'Adresse Gmail invalide.' };
  }
  if (cleanPass.length !== 16) {
    return { ok: false, error: 'Le mot de passe d\'application doit comporter exactement 16 caractères.' };
  }
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: cleanUser, pass: cleanPass }
  });
  try {
    await t.verify();
    return { ok: true, transporter: t, email: cleanUser };
  } catch (e) {
    return { ok: false, error: friendlySmtpError(e) };
  }
}

async function initAdminGmail() {
  try {
    const store = await getUsersStore();
    const adminCreds = (store.admin?.gmail?.email && store.admin?.gmail?.pass)
      ? { user: store.admin.gmail.email, pass: store.admin.gmail.pass }
      : readEnvCreds();

    if (adminCreds.user && adminCreds.pass) {
      const v = await createAndVerifyTransporter(adminCreds.user, adminCreds.pass);
      if (v.ok) {
        adminGmail = { connected: true, email: v.email, error: '' };
        userTransporters.set('admin', { transporter: v.transporter, email: v.email });
      } else {
        adminGmail = { connected: false, email: adminCreds.user, error: v.error };
      }
    }
  } catch (e) {
    console.error('Error initializing admin Gmail:', e.message);
  }
}

async function getTransporterForRequest(req) {
  if (req.isAdmin) {
    const cached = userTransporters.get('admin');
    if (cached && cached.transporter) return cached;
    const store = await getUsersStore();
    const creds = store.admin?.gmail || readEnvCreds();
    if (creds.user && creds.pass) {
      const v = await createAndVerifyTransporter(creds.user, creds.pass);
      if (v.ok) {
        adminGmail = { connected: true, email: v.email, error: '' };
        const entry = { transporter: v.transporter, email: v.email };
        userTransporters.set('admin', entry);
        return entry;
      }
    }
    return null;
  }

  const user = req.user;
  if (!user) return null;

  const cached = userTransporters.get(user.id);
  if (cached && cached.transporter) return cached;

  if (user.gmail?.email && user.gmail?.pass) {
    const v = await createAndVerifyTransporter(user.gmail.email, user.gmail.pass);
    if (v.ok) {
      const entry = { transporter: v.transporter, email: v.email };
      userTransporters.set(user.id, entry);
      return entry;
    }
  }

  return null;
}

async function writeEnv(updates) {
  let text = '';
  try { text = await fsp.readFile(ENV_PATH, 'utf8'); } catch { /* new file */ }
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, () => line);
    else text += (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
  }
  await fsp.writeFile(ENV_PATH, text, 'utf8');
}

/* ============================ persistence ============================ */

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
const writeJson = (file, data) => fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');

const PFLEGE_DB_PATH = path.join(DATA_DIR, 'pflege_emails_database.json');
const PFLEGE_TXT_PATH = path.join(DATA_DIR, 'pflege_recipients_list.txt');

async function getPflegeDatabase() {
  const list = await readJson(PFLEGE_DB_PATH, null);
  if (Array.isArray(list)) return list;
  try {
    const text = await fsp.readFile(PFLEGE_TXT_PATH, 'utf8');
    const parsed = [];
    text.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(/[,;\t]/).map(s => s.trim());
      if (parts[0] && EMAIL_RE.test(parts[0])) {
        parsed.push({
          email: parts[0],
          name: parts[1] || 'Recrutement',
          company: parts[2] || 'Entreprise Allemagne',
          region: parts[3] || '',
          category: parts[4] || 'Gesundheit & Pflege'
        });
      }
    });
    if (parsed.length > 0) {
      await writeJson(PFLEGE_DB_PATH, parsed);
      return parsed;
    }
  } catch {}
  return [];
}

/* ============================ Smart Company Cleaner & Dynamic Salutations ============================ */
function cleanGermanCompanyName(name, email = '') {
  let s = (name || '').replace(/[\uE000-\uF8FF]/g, '').trim();
  if (!s || s === 'Entreprise' || s === 'Entreprise Allemagne' || s === 'azubiyo' || s === 'Standard' || s === 'undefined' || s === 'null') {
    if (email) {
      const dom = (email.split('@')[1] || '').replace(/\.(de|com|org|net|care|eu|info|org\..*)$/i, '');
      const cleanDom = dom.replace(/[-_.]+/g, ' ').trim().split(' ').map(w => {
        const u = w.toUpperCase();
        if (['AWO', 'DRK', 'BRK', 'ASB', 'BMW', 'DHL', 'DB', 'UK', 'VW', 'SEW', 'KFW', 'AG', 'GMBH', 'EV'].includes(u)) return u;
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(' ');
      return cleanDom || 'Ihr Unternehmen';
    }
    return 'Ihr Unternehmen';
  }
  // Strip pipe or dash noise (e.g. "Auto-Zellmann GmbH | SKODA" -> "Auto-Zellmann GmbH")
  s = s.split(/\s+[|•·–—]\s+/)[0];
  // Strip legal suffixes
  s = s.replace(/\b(GmbH\s*&\s*Co\.?\s*KG|gGmbH|GmbH|AG|e\.?\s*V\.?|OHG|KGaA|UG\s*\([^)]*\)|UG|SE|Ltd\.?)\b/gi, '').trim();
  s = s.replace(/,\s*$/, '').trim();
  s = s.replace(/\s{2,}/g, ' ');
  return s || 'Ihr Unternehmen';
}

const SERVER_SALUTATIONS = [
  (c) => `Sehr geehrte Damen und Herren der ${c},`,
  (c) => `Sehr geehrtes Team von ${c},`,
  (c) => `Sehr geehrte Damen und Herren bei ${c},`,
  (c) => `Guten Tag an das Team der ${c},`,
  (c) => `Sehr geehrtes Ausbildungsteam von ${c},`,
  (c) => `Sehr geehrte Personalverantwortliche der ${c},`,
  (c) => `Sehr geehrtes Recruiting-Team von ${c},`,
  (c) => `Sehr geehrte Damen und Herren von ${c},`,
  (c) => `Sehr geehrtes Personalteam von ${c},`
];

const SERVER_GENERIC_SALUTATIONS = [
  'Sehr geehrte Damen und Herren,',
  'Sehr geehrtes Ausbildungsteam,',
  'Sehr geehrte Personalverantwortliche,',
  'Guten Tag an das Team,',
  'Sehr geehrtes Bewerbungsteam,'
];

function generateDynamicSalutation(company, email = '', seed = 0) {
  const cleanComp = cleanGermanCompanyName(company, email);
  if (!cleanComp || cleanComp === 'Ihr Unternehmen') {
    const s = SERVER_GENERIC_SALUTATIONS[Math.abs(seed) % SERVER_GENERIC_SALUTATIONS.length];
    return { cleanCompany: 'Ihr Unternehmen', salutation: s };
  }
  const idx = Math.abs(seed) % SERVER_SALUTATIONS.length;
  const salutation = SERVER_SALUTATIONS[idx](cleanComp);
  return { cleanCompany: cleanComp, salutation };
}

async function savePflegeDatabase(list) {
  await writeJson(PFLEGE_DB_PATH, list);
  const lines = list.map(item => {
    const p = [
      (item.email || '').trim(),
      (item.name || 'Recrutement').trim(),
      (item.company || 'Entreprise').trim()
    ];
    if (item.region && item.region.trim()) {
      p.push(item.region.trim());
    }
    if (item.category && item.category.trim()) {
      p.push(item.category.trim());
    }
    return p.join(', ');
  });
  await fsp.writeFile(PFLEGE_TXT_PATH, lines.join('\n'), 'utf8');
}

async function getCvMeta(userId = null) {
  const meta = await readJson(CV_META, []);
  if (!Array.isArray(meta)) return [];
  return meta.filter(m => {
    if (!fs.existsSync(path.join(CV_DIR, m.file))) return false;
    if (userId) {
      return m.userId === userId || (!m.userId && (userId === 'admin' || userId === null));
    }
    return true;
  });
}

function today() { return new Date().toISOString().slice(0, 10); }

async function getDailyStats() {
  const s = await readJson(STATS_PATH, {});
  if (s.date !== today()) {
    return { date: today(), count: 0, byUser: {} };
  }
  if (!s.byUser || typeof s.byUser !== 'object') s.byUser = {};
  return s;
}

async function getSentToday(userId = null) {
  const stats = await getDailyStats();
  if (userId) {
    return stats.byUser[userId] || 0;
  }
  return stats.count || 0;
}

async function bumpSentToday(userId = null) {
  const stats = await getDailyStats();
  stats.count = (stats.count || 0) + 1;
  if (userId) {
    stats.byUser[userId] = (stats.byUser[userId] || 0) + 1;
  }
  await writeJson(STATS_PATH, stats);
  return {
    totalSentToday: stats.count,
    userSentToday: userId ? stats.byUser[userId] : stats.count
  };
}

function getPlanLimit(plan) {
  if (plan === '1month') return 100;
  if (plan === '2month') return 200;
  if (plan === 'vip' || plan === 'unlimited') return null;
  return 0;
}

const PLAN_PRICES = {
  trial: 0,
  '1month': 50,
  '2month': 99,
  'vip': 200,
  'unlimited': 200,
  custom: 0
};

/* ============================ Password Hashing ============================ */

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

/* ============================ email helpers ============================ */

function toHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;">' +
    linked.replace(/\r?\n/g, '<br>') + '</div>';
}

async function sendOne({ to, subject, body, senderName, attachCv, userId = null, transporter: tx = null, senderEmail = null }) {
  if (!tx) throw new Error('Gmail n\'est pas connecté. Veuillez d\'abord connecter votre propre compte Gmail.');
  to = String(to || '').trim();
  if (!EMAIL_RE.test(to)) throw new Error(`Adresse destinataire invalide: ${to}`);
  if (!String(subject || '').trim()) throw new Error('L\'objet de l\'email est vide.');
  if (!String(body || '').trim()) throw new Error('Le message est vide.');

  const attachments = [];
  if (attachCv) {
    const cvs = await getCvMeta(userId);
    if (!cvs || cvs.length === 0) throw new Error('Aucun CV trouvé. Veuillez d\'abord importer votre CV en PDF.');
    for (const cv of cvs) {
      attachments.push({ filename: cv.name, path: path.join(CV_DIR, cv.file), contentType: cv.mimeType || 'application/pdf' });
    }
  }

  const name = String(senderName || '').trim();
  const fromAddr = senderEmail || (tx.options?.auth?.user);
  const info = await tx.sendMail({
    from: name ? { name, address: fromAddr } : fromAddr,
    to,
    subject: String(subject),
    text: String(body),
    html: toHtml(body),
    attachments
  });
  const bump = await bumpSentToday(userId);
  return { messageId: info.messageId, sentToday: bump.totalSentToday, userSentToday: bump.userSentToday };
}

function sendErrorPayload(e) {
  const msg = friendlySmtpError(e);
  return {
    ok: false,
    error: msg,
    quotaExceeded: /5\.4\.5|daily user sending limit|sending limit exceeded|quota/i.test((e && e.message) || '')
  };
}

const USERS_PATH = path.join(DATA_DIR, 'users.json');

async function getUsersStore() {
  const defaultStore = {
    admin: {
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      whatsappPhone: process.env.WHATSAPP_PHONE || '491773910477',
      whatsappPhoneDe: '491773910477',
      whatsappPhoneMa: '212655529769'
    },
    requests: [],
    users: [],
    tokens: {},
    activities: [],
    payments: []
  };
  const store = await readJson(USERS_PATH, defaultStore);
  if (!store.admin) store.admin = defaultStore.admin;
  if (!store.admin.email || store.admin.email === 'admin@autocv-system.de') store.admin.email = ADMIN_EMAIL;
  if (!store.admin.passcode || store.admin.passcode === 'Amine@0105') store.admin.passcode = ADMIN_PASSWORD;
  if (!store.admin.passwordHash || store.admin.passwordHash === 'd9846a2f4990eef991a079bad99ba39183c79760a4fee0f0e82e1402cdb431ed') {
    store.admin.passwordHash = hashPassword(ADMIN_PASSWORD);
  }
  if (!store.admin.whatsappPhone || store.admin.whatsappPhone === '212600000000') {
    store.admin.whatsappPhone = '491773910477';
  }
  if (!store.admin.whatsappPhoneDe) store.admin.whatsappPhoneDe = '491773910477';
  if (!store.admin.whatsappPhoneMa) store.admin.whatsappPhoneMa = '212655529769';
  if (!store.requests) store.requests = [];
  if (!store.users) store.users = [];
  if (!store.tokens) store.tokens = {};
  if (!store.activities) store.activities = [];
  if (!store.payments) store.payments = [];
  return store;
}

async function saveUsersStore(store) {
  await writeJson(USERS_PATH, store);
}

async function logActivity({ type, userName, userEmail, userId, details }) {
  try {
    const store = await getUsersStore();
    if (!store.activities) store.activities = [];
    store.activities.unshift({
      id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: type || 'info',
      userName: userName || 'Anonyme',
      userEmail: userEmail || '—',
      userId: userId || null,
      details: details || '',
      timestamp: new Date().toISOString()
    });
    if (store.activities.length > 300) {
      store.activities = store.activities.slice(0, 300);
    }
    await saveUsersStore(store);
  } catch (e) {
    console.error('Failed to log activity:', e.message);
  }
}

function checkUserStatus(user) {
  if (!user) return { status: 'invalid', message: 'Utilisateur non trouvé' };
  if (user.status === 'pending') {
    return { status: 'pending', message: 'Votre compte est en attente de confirmation par l\'administrateur.' };
  }
  if (user.status === 'banned') {
    return { status: 'banned', message: '⛔ Votre compte a été banni et bloqué par l\'administrateur.' };
  }
  if (user.status === 'disconnected') {
    return { status: 'disconnected', message: 'Votre compte a été déconnecté par l\'administrateur.' };
  }
  if (user.expiresAt) {
    const expiresMs = new Date(user.expiresAt).getTime();
    const nowMs = Date.now();
    if (nowMs > expiresMs) {
      return {
        status: 'expired',
        message: 'Votre période d\'essai ou votre abonnement a expiré. Veuillez choisir une formule.'
      };
    }
    const remainingSec = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
    return { status: 'active', remainingSec, user };
  }
  return { status: 'active', remainingSec: null, user };
}

/* ============================ express app ============================ */

const app = express();
app.set('trust proxy', 1); // دمج Nginx proxy في السيرفر باش يقرأ الـ IP الحقيقي ديال الزائر
app.disable('x-powered-by');

// 1. تفعيل Helmet لحماية الـ HTTP Headers مع السماح بـ CDNs الخارجية
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// 2. Rate Limiting: حماية الـ API من هجمات الـ DDoS والـ Brute Force
// ليميت عام لـ /api/ مع استثناء الـ polling لضمان عدم توقف إرسال الإيميلات
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // كل 15 دقيقة
  max: 1000, // سقف يسمح بالإرسال الجماعي والاستعلامات الدورية
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Bzzaf dyal t-talabat (Too many requests), 3awed men be3d." },
  skip: (req) => req.path === '/status' || req.path === '/scraper/status'
});
app.use('/api/', apiLimiter);

// ليميت مشدد على تسجيل الدخول لمنع تخمين كلمات المرور (Brute-Force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Bzzaf dyal mo7awalat d-dokhoul, 7awel be3d 15 d9i9a." }
});
app.use('/api/user/login', authLimiter);
app.use('/api/admin/login', authLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// 2. دالة مساعدة لتنقية المدخلات من وسوم HTML الخبيثة (XSS Prevention)
function cleanInput(text) {
  if (typeof text !== 'string') return '';
  return sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {}
  }).trim();
}

// Middleware for user & admin access verification
async function verifyAccess(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  const userToken = req.headers['x-user-token'];

  const store = await getUsersStore();

  // Admin bypass
  if (adminToken && store.tokens[adminToken]) {
    req.isAdmin = true;
    return next();
  }

  // User check
  if (userToken) {
    const user = store.users.find(u => u.token === userToken);
    if (!user) {
      return res.status(401).json({ ok: false, status: 'unauthorized', error: 'Session invalide. Veuillez vous re-connecter.' });
    }
    const check = checkUserStatus(user);
    if (check.status !== 'active') {
      return res.status(403).json({ ok: false, status: check.status, error: check.message });
    }
    req.user = user;
    return next();
  }

  // If users list is not empty, require login
  if (store.users.length > 0) {
    return res.status(401).json({ ok: false, status: 'auth_required', error: 'Connexion requise.' });
  }

  // Default initial setup mode if no users exist yet
  next();
}

/* ============================ Auth & Registration API ============================ */

function normalizePhone(p) {
  if (!p) return '';
  return String(p).replace(/[\s\-\+\(\)\.]/g, '').replace(/^212/, '0');
}

function checkIsAdmin(identifier, secret, store) {
  const s = String(secret || '').trim();
  const id = String(identifier || '').trim().toLowerCase();

  const isSecretMatch = s === 'Amine@0106' ||
                        s === 'Amine@0105' ||
                        s === 'Admin@2026Secure' ||
                        s === ADMIN_PASSWORD ||
                        (store.admin?.passcode && s === store.admin.passcode) ||
                        (store.admin?.passwordHash && verifyPassword(s, store.admin.passwordHash));

  if (!isSecretMatch) return false;

  // If secret matches, check if identifier is empty (admin passcode only) or matches admin credentials
  if (!id) return true;

  const adminEmail = (store.admin?.email || ADMIN_EMAIL || 'amineessate1@gmail.com').toLowerCase();
  const adminPhone = normalizePhone(store.admin?.whatsappPhone || '491773910477');
  const normId = normalizePhone(id);
  const rawClean = String(id).replace(/[\s\-\+\(\)\.]/g, '');

  if (id === 'admin' ||
      id === 'amineessate1@gmail.com' ||
      id === 'admin@autocv-system.de' ||
      id === adminEmail ||
      rawClean === '491773910477' ||
      rawClean === '01773910477' ||
      rawClean === '1773910477' ||
      rawClean === '212655529769' ||
      rawClean === '0655529769' ||
      normId === adminPhone ||
      normId === '0655529769' ||
      normId === '065529769' ||
      normId === '212655529769' ||
      normId === '491773910477' ||
      normId === '01773910477') {
    return true;
  }

  // If passcode is exactly the unique admin passcode Amine@0106 or Amine@0105, treat as admin
  if (s === 'Amine@0106' || s === 'Amine@0105' || s === 'Admin@2026Secure') {
    return true;
  }

  return false;
}

// Access Request / Registration (supports both /api/access-request and /api/auth/register)
app.post(['/api/access-request', '/api/auth/register'], async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const passcode = String(req.body?.passcode || req.body?.password || '').trim();
  const domain = String(req.body?.ausbildungDomain || '').trim();
  const specialty = String(req.body?.ausbildungSpecialty || '').trim();
  const message = String(req.body?.message || '').trim();
  const plan = ['1month', '2month', 'vip'].includes(req.body?.plan) ? req.body.plan : (req.body?.plan === 'trial' ? 'trial' : '1month');

  const store = await getUsersStore();

  // 1. Check if Admin credentials provided
  if (checkIsAdmin(email || phone, passcode, store)) {
    const adminToken = 'admin_tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    store.tokens[adminToken] = true;
    await saveUsersStore(store);
    await logActivity({
      type: 'login',
      userName: 'Super Admin',
      userEmail: email || 'admin@autocv-system.de',
      details: 'Connexion Administrateur via formulaire d\'accès'
    });
    return res.json({
      ok: true,
      isAdmin: true,
      adminToken,
      message: 'Bienvenue Administrateur !'
    });
  }

  if (!name && !email && !phone) {
    return res.status(400).json({ ok: false, error: 'Veuillez remplir vos informations.' });
  }

  // 2. Check if user already exists
  const normPhone = normalizePhone(phone);
  const existingUser = store.users.find(u => {
    if (email && u.email && u.email.toLowerCase() === email) return true;
    if (normPhone && u.phone && normalizePhone(u.phone) === normPhone) return true;
    return false;
  });

  if (existingUser) {
    if (!existingUser.token) {
      existingUser.token = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
      await saveUsersStore(store);
    }
    const check = checkUserStatus(existingUser);
    return res.json({
      ok: true,
      alreadyUser: true,
      token: existingUser.token,
      user: existingUser,
      statusInfo: check,
      status: existingUser.status,
      message: 'Compte existant trouvé.'
    });
  }

  // 3. Create new user & request
  const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const userToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  const now = Date.now();

  const isTrial = (plan === 'trial');
  const trialDuration = 3 * 3600 * 1000; // 3 hours

  const newUser = {
    id: userId,
    token: isTrial ? userToken : null,
    name: name || 'Utilisateur',
    phone: phone || '',
    email: email || '',
    passcode: passcode || '',
    passwordHash: passcode ? hashPassword(passcode) : '',
    ausbildungDomain: domain,
    ausbildungSpecialty: specialty,
    status: isTrial ? 'active' : 'pending',
    plan: isTrial ? 'trial' : null,
    requestedPlan: plan,
    trialStartedAt: isTrial ? new Date(now).toISOString() : null,
    expiresAt: isTrial ? new Date(now + trialDuration).toISOString() : null,
    createdAt: new Date().toISOString()
  };

  store.users.unshift(newUser);

  const newReq = {
    id: reqId,
    userId,
    name: name || 'Utilisateur',
    phone,
    email,
    ausbildungDomain: domain,
    ausbildungSpecialty: specialty,
    message,
    requestedPlan: plan,
    status: isTrial ? 'approved' : 'pending',
    createdAt: new Date().toISOString()
  };
  store.requests.unshift(newReq);

  await saveUsersStore(store);

  await logActivity({
    type: 'register',
    userName: name || 'Utilisateur',
    userEmail: email || phone,
    details: `Nouvelle demande (${plan}) : ${name} (${phone || email})`
  });

  // Notify admin via Gmail if connected
  const adminEntry = userTransporters.get('admin');
  if (adminEntry && adminGmail.connected) {
    try {
      await adminEntry.transporter.sendMail({
        from: adminGmail.email,
        to: adminGmail.email,
        subject: `🔔 [Auto-CV] Nouvelle demande: ${name || 'Nouveau membre'}`,
        text: `Nouvelle demande au système Auto-CV Sender:\n\nNom: ${name}\nTél: ${phone}\nEmail: ${email}\nDomaine: ${domain}\nFormule: ${plan}\n\nConnectez-vous au panneau Admin pour gérer cette demande.`
      });
    } catch (e) {
      console.error('Failed to send admin email alert:', e.message);
    }
  }

  if (isTrial) {
    return res.json({
      ok: true,
      autoTrial: true,
      token: userToken,
      user: newUser,
      message: '🎉 Essai 3 Heures activé ! Vous pouvez envoyer vos candidatures immédiatement.'
    });
  }

  return res.json({
    ok: true,
    status: 'pending',
    message: 'Votre demande a été enregistrée avec succès ! En attente de confirmation par l\'administrateur.'
  });
});

// User / Admin Login (supports both /api/user/login and /api/auth/login)
app.post(['/api/user/login', '/api/auth/login'], async (req, res) => {
  const rawIdentifier = String(req.body?.phone || req.body?.email || req.body?.identifier || '').trim();
  const rawSecret = String(req.body?.passcode || req.body?.password || '').trim();

  if (!rawIdentifier && !rawSecret) {
    return res.status(400).json({ ok: false, error: 'Veuillez saisir votre numéro, email ou code d\'accès.' });
  }

  const store = await getUsersStore();

  // 1. Check if Admin credentials
  if (checkIsAdmin(rawIdentifier, rawSecret, store)) {
    const adminToken = 'admin_tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    store.tokens[adminToken] = true;
    await saveUsersStore(store);
    await logActivity({
      type: 'login',
      userName: 'Super Admin',
      userEmail: rawIdentifier || 'admin@autocv-system.de',
      details: 'Connexion Administrateur'
    });
    return res.json({
      ok: true,
      isAdmin: true,
      adminToken,
      message: 'Bienvenue Administrateur !'
    });
  }

  // 2. Regular User Login
  const normId = normalizePhone(rawIdentifier);
  const idLower = rawIdentifier.toLowerCase();

  const user = store.users.find(u => {
    if (u.email && u.email.toLowerCase() === idLower) return true;
    if (normId && u.phone && normalizePhone(u.phone) === normId) return true;
    if (u.name && u.name.toLowerCase() === idLower) return true;
    return false;
  });

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'Aucun compte trouvé avec cet identifiant. Veuillez vous inscrire d\'abord.'
    });
  }

  // Verify password if set on user
  if (rawSecret) {
    const isPassValid = (user.passcode && user.passcode === rawSecret) ||
                        (user.passwordHash && verifyPassword(rawSecret, user.passwordHash)) ||
                        (!user.passcode && !user.passwordHash);

    if (!isPassValid) {
      return res.status(401).json({ ok: false, error: 'Mot de passe ou code d\'accès incorrect.' });
    }
  }

  const check = checkUserStatus(user);

  if (check.status === 'pending') {
    return res.json({
      ok: false,
      status: 'pending',
      message: 'Votre compte est en attente de confirmation par l\'administrateur.'
    });
  }

  if (check.status !== 'active') {
    return res.status(403).json({ ok: false, status: check.status, error: check.message });
  }

  if (!user.token) {
    user.token = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
    await saveUsersStore(store);
  }

  await logActivity({
    type: 'login',
    userName: user.name,
    userEmail: user.email || user.phone,
    userId: user.id,
    details: 'Connexion utilisateur'
  });

  res.json({
    ok: true,
    user,
    token: user.token,
    statusInfo: check,
    message: 'Connexion réussie !'
  });
});

app.get('/api/user/me', async (req, res) => {
  const userToken = req.headers['x-user-token'];
  const store = await getUsersStore();
  const user = store.users.find(u => u.token === userToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Non connecté' });
  const check = checkUserStatus(user);
  const plan = user.plan || 'trial';
  const dailyLimit = getPlanLimit(plan);
  const userSentToday = await getSentToday(user.id);
  const remainingToday = dailyLimit !== null ? Math.max(0, dailyLimit - userSentToday) : null;

  res.json({
    ok: true,
    user,
    statusInfo: check,
    limits: {
      dailyLimit,
      sentToday: userSentToday,
      remainingToday
    }
  });
});

/* ============================ Admin API ============================ */

app.post('/api/user/domain', async (req, res) => {
  const userToken = req.headers['x-user-token'];
  const domain = String(req.body?.domain || '').trim();
  if (!userToken) return res.status(401).json({ ok: false, error: 'Non connecté.' });
  if (!domain) return res.status(400).json({ ok: false, error: 'Domaine requis.' });

  const store = await getUsersStore();
  const user = store.users.find(u => u.token === userToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Utilisateur introuvable.' });

  user.domain = domain;
  await saveUsersStore(store);
  res.json({ ok: true, domain, user });
});

app.post(['/api/admin/login', '/api/admin-login'], async (req, res) => {
  const passcode = String(req.body?.passcode || req.body?.password || '').trim();
  const email = String(req.body?.email || req.body?.phone || '').trim();
  const store = await getUsersStore();

  if (checkIsAdmin(email, passcode, store)) {
    const token = 'admin_tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    store.tokens[token] = true;
    await saveUsersStore(store);
    await logActivity({
      type: 'login',
      userName: 'Super Admin',
      userEmail: email || 'admin@autocv-system.de',
      details: 'Connexion Administrateur directe'
    });
    return res.json({ ok: true, isAdmin: true, adminToken: token, message: 'Bienvenue Administrateur !' });
  }

  return res.status(401).json({ ok: false, error: 'Code secret ou mot de passe administrateur incorrect.' });
});

async function requireAdmin(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  const store = await getUsersStore();
  if (!adminToken || !store.tokens[adminToken]) {
    return res.status(401).json({ ok: false, error: 'Accès administrateur requis.' });
  }
  req.adminStore = store;
  next();
}

app.get('/api/admin/data', requireAdmin, async (req, res) => {
  const store = req.adminStore;
  if (!store.activities) store.activities = [];
  if (!store.payments) store.payments = [];

  const usersWithStatus = await Promise.all(store.users.map(async u => {
    const sentToday = await getSentToday(u.id);
    const limit = getPlanLimit(u.plan);
    return {
      ...u,
      sentToday,
      dailyLimit: limit,
      statusInfo: checkUserStatus(u)
    };
  }));

  let totalRevenue = 0;
  if (store.payments.length > 0) {
    store.payments.forEach(p => { totalRevenue += (Number(p.amount) || 0); });
  } else {
    store.users.forEach(u => {
      totalRevenue += (PLAN_PRICES[u.plan] || 0);
    });
  }

  const planStats = {
    trial: store.users.filter(u => u.plan === 'trial').length,
    '1month': store.users.filter(u => u.plan === '1month').length,
    '2month': store.users.filter(u => u.plan === '2month').length,
    vip: store.users.filter(u => u.plan === 'vip').length,
    custom: store.users.filter(u => u.plan === 'custom').length
  };

  const planRevenue = {
    '1month': planStats['1month'] * 50,
    '2month': planStats['2month'] * 99,
    vip: planStats.vip * 200
  };

  const statsJson = await getDailyStats();

  res.json({
    ok: true,
    requests: store.requests,
    users: usersWithStatus,
    activities: store.activities.slice(0, 150),
    payments: store.payments.slice(0, 50),
    stats: {
      totalRevenue,
      planStats,
      planRevenue,
      totalUsers: store.users.length,
      activeUsers: store.users.filter(u => checkUserStatus(u).status === 'active').length,
      bannedUsers: store.users.filter(u => u.status === 'banned').length,
      pendingRequests: store.requests.filter(r => r.status === 'pending').length,
      totalSentToday: statsJson.count || 0
    },
    admin: {
      whatsappPhone: store.admin.whatsappPhone || '491773910477',
      whatsappPhoneDe: store.admin.whatsappPhoneDe || '491773910477',
      whatsappPhoneMa: store.admin.whatsappPhoneMa || '212655529769',
      email: store.admin.email || ADMIN_EMAIL
    }
  });
});

// NEW: Admin Approve User (with free trial activation)
app.post('/api/admin/approve', requireAdmin, async (req, res) => {
  const { requestId, plan } = req.body || {};
  const store = req.adminStore;

  const reqItem = store.requests.find(r => r.id === requestId);
  if (!reqItem) return res.status(404).json({ ok: false, error: 'Demande introuvable.' });

  reqItem.status = 'approved';

  let user = store.users.find(u => u.id === reqItem.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });

  // Activate free trial first
  const now = Date.now();
  const trialDuration = 3 * 3600 * 1000; // 3 hours

  user.status = 'active';
  user.plan = 'trial';
  user.token = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  user.trialStartedAt = new Date(now).toISOString();
  user.expiresAt = new Date(now + trialDuration).toISOString();
  user.approvedAt = new Date().toISOString();

  await saveUsersStore(store);
  await logActivity({
    type: 'approve',
    userName: user.name,
    userEmail: user.email,
    userId: user.id,
    details: `Compte approuvé : Essai gratuit de 3 heures activé`
  });

  res.json({ ok: true, user });
});

app.post('/api/admin/reject', requireAdmin, async (req, res) => {
  const { requestId } = req.body || {};
  const store = req.adminStore;
  const reqItem = store.requests.find(r => r.id === requestId);
  if (reqItem) {
    reqItem.status = 'rejected';
    const user = store.users.find(u => u.id === reqItem.userId);
    if (user) {
      user.status = 'rejected';
    }
    await logActivity({
      type: 'reject',
      userName: reqItem.name,
      userEmail: reqItem.email,
      details: 'Demande d\'accès refusée par l\'admin'
    });
  }
  await saveUsersStore(store);
  res.json({ ok: true });
});

app.post('/api/admin/set-plan', requireAdmin, async (req, res) => {
  const { userId, plan, customHours } = req.body || {};
  const store = req.adminStore;
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });

  const now = Date.now();
  let expiresMs = now + 3 * 3600 * 1000;
  if (plan === '1month') expiresMs = now + 30 * 24 * 3600 * 1000;
  else if (plan === '2month') expiresMs = now + 60 * 24 * 3600 * 1000;
  else if (plan === 'vip') expiresMs = now + 90 * 24 * 3600 * 1000;
  else if (plan === 'custom' && Number(customHours) > 0) expiresMs = now + Number(customHours) * 3600 * 1000;

  user.plan = plan;
  user.status = 'active';
  user.expiresAt = new Date(expiresMs).toISOString();

  if (PLAN_PRICES[plan] && PLAN_PRICES[plan] > 0) {
    if (!store.payments) store.payments = [];
    store.payments.unshift({
      id: 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      plan: plan,
      amount: PLAN_PRICES[plan],
      date: new Date().toISOString()
    });
  }

  await saveUsersStore(store);
  await logActivity({
    type: 'plan',
    userName: user.name,
    userEmail: user.email,
    userId: user.id,
    details: `Changement de formule : ${plan} (${PLAN_PRICES[plan] || 0} DH)`
  });

  res.json({ ok: true, user, statusInfo: checkUserStatus(user) });
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const { userId, banned = true } = req.body || {};
  const store = req.adminStore;
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });

  user.status = banned ? 'banned' : 'active';
  await saveUsersStore(store);
  await logActivity({
    type: banned ? 'ban' : 'unban',
    userName: user.name,
    userEmail: user.email,
    userId: user.id,
    details: banned ? '⛔ Utilisateur banni et bloqué' : '✅ Utilisateur réactivé'
  });
  res.json({ ok: true, user, statusInfo: checkUserStatus(user) });
});

app.post('/api/admin/disconnect', requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  const store = req.adminStore;
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable.' });

  user.status = 'disconnected';
  await saveUsersStore(store);
  await logActivity({
    type: 'disconnect',
    userName: user.name,
    userEmail: user.email,
    userId: user.id,
    details: 'Utilisateur déconnecté par l\'administrateur'
  });
  res.json({ ok: true, user });
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  const store = req.adminStore;
  const u = store.users.find(x => x.id === userId);
  if (u) {
    await logActivity({
      type: 'delete',
      userName: u.name,
      userEmail: u.email,
      details: 'Compte utilisateur supprimé'
    });
  }
  store.users = store.users.filter(x => x.id !== userId);
  await saveUsersStore(store);
  res.json({ ok: true });
});

app.post('/api/admin/update-settings', requireAdmin, async (req, res) => {
  const { password, whatsappPhone } = req.body || {};
  const store = req.adminStore;

  if (password && password.trim().length >= 6) {
    store.admin.passwordHash = hashPassword(password.trim());
  }
  if (whatsappPhone) {
    store.admin.whatsappPhone = whatsappPhone.trim();
  }
  await saveUsersStore(store);
  res.json({ ok: true });
});

/* Admin Email Database Management */

// Full list of all supported Ausbildung domains
const ALL_CATEGORIES = [
  'Verkäufer & Einzelhandel (المبيعات وتجارة التجزئة)',
  'Gesundheit, Pflege & Medizin (الصحة والتمريض)',
  'IT & Digitalisierung (المعلومات والتكنولوجيا)',
  'Technik, Industrie & Handwerk (التقنية والصناعة والحرف)',
  'Kaufmännische Berufe & Logistik (التجارة والإدارة واللوجستيك)',
  'Hotellerie, Gastronomie & Tourismus (الفندقة والمطاعم والسياحة)',
  'Verkehr, Bahn & Luftfahrt (النقل والسكك الحديدية والطيران)',
  'Soziales & Pädagogik (المجال الاجتماعي والتربوي)',
  'Autre / تخصص آخر'
];

function matchCategory(dbCategory, filterKey) {
  const cat = (dbCategory || '').toLowerCase().trim();
  const f = (filterKey || '').toLowerCase().trim();
  if (!cat || !f || f === 'all') return true;

  // Direct exact match
  if (cat === f) return true;

  switch (f) {
    case 'verkaeufer':
    case 'verkäufer':
    case 'einzelhandel':
    case 'verkauf':
    case 'vente':
      return cat.includes('verkäuf') || cat.includes('verkaeuf') || cat.includes('einzelhandel') || cat.includes('verkauf') || cat.includes('مبيعات') || cat.includes('تجزئة');
    case 'gesundheit':
    case 'pflege':
    case 'medizin':
      return cat.includes('gesundheit') || cat.includes('pflege') || cat.includes('medizin') || cat.includes('صحة') || cat.includes('تمريض');
    case 'it':
    case 'digital':
    case 'digitalisierung':
      return /\b(it|informatik|software|digital|digitalisierung)\b/i.test(cat) || cat.includes('معلوميات') || cat.includes('تكنولوجيا');
    case 'technik':
    case 'industrie':
    case 'handwerk':
      return cat.includes('technik') || cat.includes('industrie') || cat.includes('handwerk') || cat.includes('تقنية') || cat.includes('صناعة') || cat.includes('حرف');
    case 'wirtschaft':
    case 'kaufmaennisch':
    case 'kaufmannisch':
    case 'kaufm':
    case 'logistik':
    case 'handel':
      return cat.includes('wirtschaft') || cat.includes('kaufm') || cat.includes('logistik') || cat.includes('تجارة') || cat.includes('إدارة') || cat.includes('لوجستيك');
    case 'hotel':
    case 'hotellerie':
    case 'gastro':
    case 'gastronomie':
    case 'tourismus':
      return cat.includes('hotel') || cat.includes('gastro') || cat.includes('touris') || cat.includes('فندقة') || cat.includes('مطاعم') || cat.includes('سياحة');
    case 'verkehr':
    case 'bahn':
    case 'luftfahrt':
    case 'transport':
      return cat.includes('verkehr') || cat.includes('bahn') || cat.includes('luftfahrt') || cat.includes('نقل') || cat.includes('سكك') || cat.includes('طيران');
    case 'sozial':
    case 'soziales':
    case 'paedagogik':
    case 'pädagogik':
    case 'padagogik':
    case 'erzieher':
      return cat.includes('sozial') || cat.includes('päd') || cat.includes('pad') || cat.includes('erzieh') || cat.includes('اجتماعي') || cat.includes('تربوي');
    case 'autre':
    case 'other':
      return cat.includes('autre') || cat.includes('تخصص') || cat.includes('sonstig') || cat.includes('other');
    default:
      if (f.length > 2 && (cat.includes(f) || f.includes(cat))) return true;
      return false;
  }
}

function getCategoryCounts(db) {
  return {
    all: db.length,
    verkaeufer: db.filter(i => matchCategory(i.category, 'verkaeufer')).length,
    pflege: db.filter(i => matchCategory(i.category, 'pflege')).length,
    gesundheit: db.filter(i => matchCategory(i.category, 'gesundheit')).length,
    it: db.filter(i => matchCategory(i.category, 'it')).length,
    digital: db.filter(i => matchCategory(i.category, 'digital')).length,
    technik: db.filter(i => matchCategory(i.category, 'technik')).length,
    industrie: db.filter(i => matchCategory(i.category, 'industrie')).length,
    logistik: db.filter(i => matchCategory(i.category, 'logistik')).length,
    wirtschaft: db.filter(i => matchCategory(i.category, 'wirtschaft')).length,
    kaufm: db.filter(i => matchCategory(i.category, 'kaufm')).length,
    hotel: db.filter(i => matchCategory(i.category, 'hotel')).length,
    tourismus: db.filter(i => matchCategory(i.category, 'hotel')).length,
    verkehr: db.filter(i => matchCategory(i.category, 'verkehr')).length,
    sozial: db.filter(i => matchCategory(i.category, 'sozial')).length,
    autre: db.filter(i => matchCategory(i.category, 'autre')).length
  };
}

app.get('/api/admin/emails', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    const search = String(req.query.search || '').trim().toLowerCase();
    const categoryFilter = String(req.query.category || 'all').trim().toLowerCase();

    const db = await getPflegeDatabase();

    // Count per category
    const categoryCounts = getCategoryCounts(db);

    let filtered = db;
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(item => matchCategory(item.category, categoryFilter));
    }

    if (search) {
      filtered = filtered.filter(item => {
        return (item.email && item.email.toLowerCase().includes(search)) ||
               (item.name && item.name.toLowerCase().includes(search)) ||
               (item.company && item.company.toLowerCase().includes(search)) ||
               (item.region && item.region.toLowerCase().includes(search)) ||
               (item.category && item.category.toLowerCase().includes(search));
      });
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const emails = filtered.slice(start, start + limit);

    res.json({
      ok: true,
      total,
      totalAll: db.length,
      categories: {
        all: db.length,
        ...categoryCounts
      },
      availableCategories: ALL_CATEGORIES,
      page,
      limit,
      totalPages,
      emails
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/emails/add', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const company = String(req.body?.company || '').trim();
    const region = String(req.body?.region || '').trim();
    const category = String(req.body?.category || '').trim() || 'Gesundheit, Pflege & Medizin (الصحة والتمريض)';

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Adresse email invalide.' });
    }

    const db = await getPflegeDatabase();
    const existingIdx = db.findIndex(item => item.email && item.email.toLowerCase() === email);

    const newItem = {
      email: email,
      name: name || 'Recrutement',
      company: company || 'Entreprise Allemagne',
      region: region || '',
      category: category,
      addedAt: new Date().toISOString()
    };

    if (existingIdx !== -1) {
      db[existingIdx] = Object.assign(db[existingIdx], newItem);
    } else {
      db.unshift(newItem);
    }

    await savePflegeDatabase(db);
    res.json({
      ok: true,
      message: existingIdx !== -1 ? 'Email mis à jour avec succès !' : 'Email ajouté avec succès à la base !',
      total: db.length,
      item: newItem
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/emails/bulk-add', requireAdmin, async (req, res) => {
  try {
    const rawText = String(req.body?.rawText || '').trim();
    const defaultCategory = String(req.body?.category || '').trim() || 'Gesundheit, Pflege & Medizin (الصحة والتمريض)';
    if (!rawText) {
      return res.status(400).json({ ok: false, error: 'Veuillez coller des emails à ajouter.' });
    }

    const db = await getPflegeDatabase();
    const seenMap = new Set(db.map(item => (item.email || '').toLowerCase().trim()));

    let addedCount = 0;
    let dupCount = 0;
    const newlyAdded = [];

    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/[,;\t]/).map(s => s.trim().replace(/^["']|["']$/g, ''));
      let emailFound = '';
      let nameFound = '';
      let companyFound = '';
      let regionFound = '';
      let categoryFound = defaultCategory;

      for (let i = 0; i < parts.length; i++) {
        if (EMAIL_RE.test(parts[i])) {
          emailFound = parts[i].toLowerCase();
          const rest = parts.filter((_, idx) => idx !== i);
          nameFound = rest[0] || '';
          companyFound = rest[1] || '';
          regionFound = rest[2] || '';
          if (rest[3]) categoryFound = rest[3];
          break;
        }
      }

      if (!emailFound) {
        const match = trimmed.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (match) emailFound = match[0].toLowerCase();
      }

      if (emailFound) {
        if (seenMap.has(emailFound)) {
          dupCount++;
        } else {
          seenMap.add(emailFound);
          newlyAdded.push({
            email: emailFound,
            name: nameFound || 'Recrutement',
            company: companyFound || 'Entreprise Allemagne',
            region: regionFound || '',
            category: categoryFound,
            addedAt: new Date().toISOString()
          });
          addedCount++;
        }
      }
    }

    if (addedCount > 0) {
      db.unshift(...newlyAdded);
      await savePflegeDatabase(db);
    }

    res.json({
      ok: true,
      addedCount,
      dupCount,
      total: db.length,
      message: `${addedCount} email(s) ajouté(s) avec succès (${dupCount} doublons ignorés).`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/emails/delete', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email requis pour la suppression.' });
    }

    let db = await getPflegeDatabase();
    const initialLen = db.length;
    db = db.filter(item => item.email && item.email.toLowerCase() !== email);

    if (db.length === initialLen) {
      return res.status(404).json({ ok: false, error: 'Email introuvable dans la base.' });
    }

    await savePflegeDatabase(db);
    res.json({
      ok: true,
      total: db.length,
      message: 'Email supprimé avec succès.'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/emails/clear', requireAdmin, async (req, res) => {
  try {
    await savePflegeDatabase([]);
    res.json({
      ok: true,
      total: 0,
      message: 'Base d\'emails entièrement vidée avec succès.'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================ Core Application Endpoints ============================ */

app.get('/api/status', verifyAccess, async (req, res) => {
  const user = req.user;
  const isAdmin = req.isAdmin;

  let userGmailStatus = { connected: false, email: '', error: 'Gmail nicht verbunden' };

  if (isAdmin) {
    userGmailStatus = {
      connected: adminGmail.connected,
      email: adminGmail.email,
      error: adminGmail.error
    };
  } else if (user) {
    if (user.gmail && user.gmail.email && user.gmail.pass) {
      const tInfo = await getTransporterForRequest(req);
      if (tInfo) {
        userGmailStatus = { connected: true, email: user.gmail.email, error: '' };
      } else {
        userGmailStatus = { connected: false, email: user.gmail.email, error: 'Identifiants Gmail invalides ou expirés.' };
      }
    } else {
      userGmailStatus = { connected: false, email: '', error: 'Gmail nicht verbunden' };
    }
  } else {
    // Visitor: never reveal admin email to unauthenticated users!
    userGmailStatus = { connected: false, email: '', error: 'Non connecté' };
  }

  const plan = user?.plan || null;
  const dailyLimit = getPlanLimit(plan);
  const userSentToday = user ? await getSentToday(user.id) : 0;
  const remainingToday = dailyLimit !== null ? Math.max(0, dailyLimit - userSentToday) : null;
  const targetUserId = user ? user.id : (isAdmin ? 'admin' : null);

  res.json({
    ...userGmailStatus,
    sentToday: await getSentToday(),
    userSentToday,
    dailyLimit,
    remainingToday,
    userPlan: plan,
    cv: await getCvMeta(targetUserId)
  });
});

app.get(['/api/presets/pflege', '/api/bewerbung/emails'], verifyAccess, async (req, res) => {
  try {
    const db = await getPflegeDatabase();
    if (!db || db.length === 0) {
      return res.status(404).json({ ok: false, error: 'Base Bewerbung indisponible.' });
    }

    const countParam = req.query.count;
    const mode = req.query.mode || 'random';
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const categoryParam = String(req.query.category || 'all').trim().toLowerCase();

    let pool = db;
    if (categoryParam !== 'all') {
      pool = db.filter(item => matchCategory(item.category, categoryParam));
    }

    let selected = pool;
    if (countParam && countParam !== 'all') {
      const count = Math.max(1, parseInt(countParam) || 20);
      if (mode === 'random') {
        const shuffled = [...pool].sort(() => 0.5 - Math.random());
        selected = shuffled.slice(0, Math.min(count, pool.length));
      } else if (mode === 'offset') {
        selected = pool.slice(offset, offset + count);
      } else {
        selected = pool.slice(0, Math.min(count, pool.length));
      }
    }

    const enrichedSelected = selected.map((item, idx) => {
      const dyn = generateDynamicSalutation(item.company, item.email, idx);
      const salutation = (item.salutation && item.salutation.length > 5) ? item.salutation : dyn.salutation;
      const cleanComp = (item.cleanCompany || dyn.cleanCompany || cleanGermanCompanyName(item.company, item.email)).trim();
      return {
        ...item,
        cleanCompany: cleanComp,
        salutation: salutation,
        company: cleanComp || item.company || 'Ihr Unternehmen',
        name: (item.name && !['Recrutement', 'Recrutement / HR', 'Personalabteilung'].includes(item.name.trim()))
          ? item.name
          : salutation.replace(/,\s*$/, '')
      };
    });

    const lines = enrichedSelected.map(item => {
      const p = [
        (item.email || '').trim(),
        (item.salutation || item.name || 'Sehr geehrte Damen und Herren,').trim(),
        (item.cleanCompany || item.company || 'Ihr Unternehmen').trim()
      ];
      if (item.region && item.region.trim()) {
        p.push(item.region.trim());
      }
      return p.join(', ');
    });

    // Dynamic category counts using getCategoryCounts
    const categoryCounts = getCategoryCounts(db);

    const text = lines.join('\n');
    res.json({
      ok: true,
      total: db.length,
      poolTotal: pool.length,
      category: categoryParam,
      categories: {
        all: db.length,
        ...categoryCounts
      },
      count: enrichedSelected.length,
      items: enrichedSelected,
      text
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Erreur lors du chargement des emails: ' + e.message });
  }
});


app.post('/api/reconnect', verifyAccess, async (req, res) => {
  const tInfo = await getTransporterForRequest(req);
  if (tInfo) {
    res.json({ connected: true, email: tInfo.email, error: '' });
  } else {
    res.json({ connected: false, email: '', error: 'Non connecté' });
  }
});

app.post('/api/connect', verifyAccess, async (req, res) => {
  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '').replace(/\s+/g, '');
  if (!EMAIL_RE.test(user)) return res.status(400).json({ connected: false, error: 'Adresse Gmail invalide.' });
  if (pass.length !== 16) return res.status(400).json({ connected: false, error: 'Le mot de passe d\'application doit comporter exactement 16 caractères.' });

  const verification = await createAndVerifyTransporter(user, pass);
  if (!verification.ok) {
    return res.status(400).json({ connected: false, email: user, error: verification.error });
  }

  const store = await getUsersStore();

  if (req.isAdmin) {
    if (!store.admin) store.admin = {};
    store.admin.gmail = { email: user, pass };
    adminGmail = { connected: true, email: user, error: '' };
    userTransporters.set('admin', { transporter: verification.transporter, email: user });
    await writeEnv({ GMAIL_USER: user, GMAIL_APP_PASS: pass });
    await saveUsersStore(store);
    return res.json({ connected: true, email: user, message: 'Gmail administrateur connecté avec succès !' });
  }

  if (req.user) {
    const dbUser = store.users.find(u => u.id === req.user.id);
    if (dbUser) {
      dbUser.gmail = { email: user, pass, connected: true };
      req.user.gmail = dbUser.gmail;
      userTransporters.set(dbUser.id, { transporter: verification.transporter, email: user });
      await saveUsersStore(store);
      await logActivity({
        type: 'connect',
        userName: dbUser.name,
        userEmail: user,
        userId: dbUser.id,
        details: `Gmail connecté : ${user}`
      });
      return res.json({ connected: true, email: user, message: 'Votre compte Gmail est connecté avec succès !' });
    }
  }

  return res.status(401).json({ connected: false, error: 'Veuillez vous connecter pour lier votre compte Gmail.' });
});

app.post('/api/disconnect', verifyAccess, async (req, res) => {
  const store = await getUsersStore();
  if (req.isAdmin) {
    if (store.admin) delete store.admin.gmail;
    adminGmail = { connected: false, email: '', error: 'Déconnecté' };
    userTransporters.delete('admin');
    await saveUsersStore(store);
    return res.json({ connected: false, email: '', message: 'Gmail administrateur déconnecté.' });
  }
  if (req.user) {
    const dbUser = store.users.find(u => u.id === req.user.id);
    if (dbUser) {
      delete dbUser.gmail;
      delete req.user.gmail;
      userTransporters.delete(dbUser.id);
      await saveUsersStore(store);
      return res.json({ connected: false, email: '', message: 'Votre compte Gmail a été déconnecté.' });
    }
  }
  res.json({ connected: false, email: '' });
});

/* ----- CV (saved locally, per-user isolated) ----- */
const upload = multer({
  storage: multer.diskStorage({
    destination: CV_DIR,
    filename: (_req, file, cb) => cb(null, `cv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: MAX_CV_BYTES, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (CV_MIME[ext]) cb(null, true);
    else cb(new Error('Only .pdf, .doc or .docx files are allowed.'));
  }
});

app.get('/api/cv', verifyAccess, async (req, res) => {
  const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
  res.json(await getCvMeta(targetUserId));
});

app.post('/api/cv', verifyAccess, upload.array('cv', 5), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Keine Dateien empfangen.' });
  const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
  const current = await getCvMeta(targetUserId);

  if (current.length + req.files.length > 5) {
    for (const file of req.files) {
      await fsp.rm(path.join(CV_DIR, file.filename), { force: true }).catch(() => {});
    }
    return res.status(400).json({
      error: `Maximal 5 PDF-Dateien erlaubt. Sie haben bereits ${current.length} Datei(en) gespeichert (Versuch: +${req.files.length}).`
    });
  }

  const allMetas = await readJson(CV_META, []);
  const newMetas = req.files.map(file => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return {
      name,
      file: file.filename,
      mimeType: CV_MIME[ext] || 'application/pdf',
      size: file.size,
      uploadedAt: new Date().toISOString(),
      userId: targetUserId
    };
  });

  const updatedAll = [...allMetas, ...newMetas];
  await writeJson(CV_META, updatedAll);
  res.json([...current, ...newMetas]);
});

app.delete('/api/cv/:filename', verifyAccess, async (req, res) => {
  const filename = req.params.filename;
  const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
  const allMetas = await readJson(CV_META, []);
  const target = allMetas.find(m => m.file === filename && (!targetUserId || m.userId === targetUserId));
  if (target) {
    await fsp.rm(path.join(CV_DIR, target.file), { force: true }).catch(() => {});
  }
  const remaining = allMetas.filter(m => !(m.file === filename && (!targetUserId || m.userId === targetUserId)));
  await writeJson(CV_META, remaining);
  res.json(await getCvMeta(targetUserId));
});

app.delete('/api/cv', verifyAccess, async (req, res) => {
  const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
  const allMetas = await readJson(CV_META, []);
  const userMetas = allMetas.filter(m => !targetUserId || m.userId === targetUserId);
  for (const meta of userMetas) {
    await fsp.rm(path.join(CV_DIR, meta.file), { force: true }).catch(() => {});
  }
  const remaining = allMetas.filter(m => targetUserId && m.userId !== targetUserId);
  await writeJson(CV_META, remaining);
  res.json([]);
});

app.get('/api/cv/file/:filename', verifyAccess, async (req, res) => {
  const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
  const metas = await getCvMeta(targetUserId);
  const meta = metas.find(m => m.file === req.params.filename);
  if (!meta) return res.status(404).send('Datei nicht gefunden.');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.type(meta.mimeType || 'application/pdf').sendFile(path.join(CV_DIR, meta.file));
});

/* ----- sending ----- */
app.post('/api/send', verifyAccess, async (req, res) => {
  try {
    const user = req.user;
    if (user && !req.isAdmin) {
      const plan = user.plan || 'trial';
      const limit = getPlanLimit(plan);
      if (limit !== null) {
        const userSentToday = await getSentToday(user.id);
        if (userSentToday >= limit) {
          await logActivity({
            type: 'limit',
            userName: user.name,
            userEmail: user.email,
            userId: user.id,
            details: `Limite journalière atteinte (${userSentToday}/${limit} emails - Forfait ${plan})`
          });
          return res.status(429).json({
            ok: false,
            limitExceeded: true,
            limit,
            sentToday: userSentToday,
            error: `Limite journalière atteinte (${userSentToday}/${limit} emails pour votre forfait). Votre quota se réinitialise chaque nuit à minuit.`
          });
        }
      }
    }

    const tInfo = await getTransporterForRequest(req);
    if (!tInfo || !tInfo.transporter) {
      return res.status(400).json({
        ok: false,
        error: req.isAdmin
          ? 'Gmail administrateur non connecté. Veuillez connecter Gmail d\'abord.'
          : 'Vous n\'avez pas encore connecté votre propre compte Gmail. Veuillez cliquer sur "Gmail verbinden" et entrer votre email et mot de passe d\'application 16 caractères.'
      });
    }

    const targetUserId = user ? user.id : (req.isAdmin ? 'admin' : null);
    const result = await sendOne({
      ...(req.body || {}),
      userId: targetUserId,
      transporter: tInfo.transporter,
      senderEmail: tInfo.email
    });

    try {
      await recordApplicationSent({
        userId: targetUserId,
        to: (req.body?.to || '').trim(),
        company: req.body?.company || req.body?.unternehmen || '',
        position: req.body?.position || req.body?.stellenbezeichnung || req.body?.subject || '',
        offerUrl: req.body?.offerUrl || '',
        platform: req.body?.platform || 'Direktbewerbung (Email)',
        notes: `Envoyé par ${tInfo.email}`
      });
    } catch (_appErr) {}

    await logActivity({
      type: 'send',
      userName: user?.name || (req.isAdmin ? 'Admin' : 'Utilisateur'),
      userEmail: tInfo.email || user?.email || '—',
      userId: user?.id,
      details: `Candidature envoyée à ${(req.body?.to || '').trim()} depuis ${tInfo.email}`
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    res.json(sendErrorPayload(e));
  }
});

app.post('/api/test', verifyAccess, async (req, res) => {
  try {
    const tInfo = await getTransporterForRequest(req);
    if (!tInfo || !tInfo.transporter) {
      return res.status(400).json({ ok: false, error: 'Gmail non connecté.' });
    }
    const targetUserId = req.user ? req.user.id : (req.isAdmin ? 'admin' : null);
    res.json({
      ok: true,
      ...(await sendOne({
        ...(req.body || {}),
        to: tInfo.email,
        userId: targetUserId,
        transporter: tInfo.transporter,
        senderEmail: tInfo.email
      }))
    });
  } catch (e) {
    res.json(sendErrorPayload(e));
  }
});

/* ============================ Ausbildung Scraper API ============================ */

// Track running scraper state
const scraperState = {
  running: false,
  log: [],
  startedAt: null,
  found: 0,
  sector: 'all',
  region: 'all',
  child: null
};

app.get('/api/scraper/ausbildung/status', async (req, res) => {
  let totalSaved = 0;
  try {
    const p = path.join(DATA_DIR, 'ausbildung_emails_database.json');
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      totalSaved = Array.isArray(arr) ? arr.length : 0;
    }
  } catch {}

  res.json({
    ok: true,
    running: scraperState.running,
    log: scraperState.log,
    startedAt: scraperState.startedAt,
    found: scraperState.found,
    sector: scraperState.sector,
    region: scraperState.region,
    totalSaved
  });
});

// SSE endpoint — streams live progress to frontend
app.get('/api/scraper/ausbildung/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  if (!scraperState.running) {
    send({ type: 'idle', message: 'Scraper is not running.' });
    return res.end();
  }

  // Replay existing log
  scraperState.log.forEach(entry => send(entry));

  // Keep connection alive
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));
});

// Start scraper — open to all visitors/users with domain and region selection
app.post('/api/scraper/ausbildung/start', async (req, res) => {
  if (scraperState.running) {
    return res.json({ ok: false, error: 'Scraper is already running.' });
  }

  const { maxPerQuery = 3, sector = 'all', region = 'all' } = req.body || {};

  scraperState.running = true;
  scraperState.log = [];
  scraperState.startedAt = new Date().toISOString();
  scraperState.found = 0;
  scraperState.sector = sector;
  scraperState.region = region;

  res.json({ ok: true, message: 'Scraper started.' });

  // Run in background using child_process
  const { spawn } = await import('node:child_process');
  const scraperPath = path.join(__dirname, 'scraper', 'ausbildung_scraper.cjs');

  const args = [
    '--maxPerQuery=' + maxPerQuery,
    '--sector=' + sector,
    '--region=' + region
  ];

  const child = spawn(process.execPath, [scraperPath, ...args], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  scraperState.child = child;

  const addLog = (type, message) => {
    const entry = { type, message, ts: new Date().toISOString() };
    scraperState.log.push(entry);
    if (scraperState.log.length > 500) scraperState.log.shift();
  };

  child.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      const trimmed = line.trim();
      let type = 'progress';
      if (trimmed.includes('[FOUND]')) {
        type = 'merge';
        scraperState.found++;
      } else if (trimmed.includes('[ERROR]')) {
        type = 'error';
      } else if (trimmed.includes('[DONE]')) {
        type = 'done';
      }
      addLog(type, trimmed);
    });
  });

  child.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      addLog('error', line.trim());
    });
  });

  child.on('close', async (code) => {
    scraperState.running = false;
    scraperState.child = null;
    addLog('done', 'Scraper finished (exit code ' + code + ')');

    // Automatically merge results into main database
    try {
      const ausbildungDbPath = path.join(DATA_DIR, 'ausbildung_emails_database.json');
      if (fs.existsSync(ausbildungDbPath)) {
        const newEmails = JSON.parse(fs.readFileSync(ausbildungDbPath, 'utf8'));
        const mainDb = await getPflegeDatabase();
        const existingEmails = new Set(mainDb.map(r => (r.email || '').toLowerCase().trim()));
        const toAdd = newEmails.filter(r => r.email && !existingEmails.has(r.email.toLowerCase().trim()));
        if (toAdd.length > 0) {
          scraperState.found = toAdd.length;
          await savePflegeDatabase([...mainDb, ...toAdd]);
          addLog('merge', toAdd.length + ' nouveaux emails fusionnés automatiquement dans la base du site.');
        } else {
          addLog('merge', 'Tous les emails trouvés existent déjà dans la base du site.');
        }
      }
    } catch (e) {
      addLog('error', 'Erreur fusion: ' + e.message);
    }
  });
});

// Stop scraper — open to all
app.post('/api/scraper/ausbildung/stop', async (req, res) => {
  if (scraperState.child) {
    try {
      scraperState.child.kill();
    } catch {}
  }
  scraperState.running = false;
  scraperState.child = null;
  res.json({ ok: true, message: 'Scraper arrêté avec succès.' });
});

// Manually merge scraped emails to site database — open to all
app.post('/api/scraper/ausbildung/merge', async (req, res) => {
  try {
    const ausbildungDbPath = path.join(DATA_DIR, 'ausbildung_emails_database.json');
    if (!fs.existsSync(ausbildungDbPath)) {
      return res.status(404).json({
        ok: false,
        error: 'Aucun email extrait pour le moment. Lancez d\'abord une recherche avec "🚀 Lancer la recherche".'
      });
    }

    let scraped = [];
    try {
      scraped = JSON.parse(fs.readFileSync(ausbildungDbPath, 'utf8'));
    } catch {
      scraped = [];
    }

    if (!Array.isArray(scraped) || scraped.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'La base des emails extraits est vide. Lancez une recherche pour trouver des emails.'
      });
    }

    const mainDb = await getPflegeDatabase();
    const existingEmails = new Set(mainDb.map(r => (r.email || '').toLowerCase().trim()));
    const toAdd = scraped.filter(r => r.email && !existingEmails.has(r.email.toLowerCase().trim()));
    const alreadyPresent = scraped.length - toAdd.length;

    let updatedDb = mainDb;
    if (toAdd.length > 0) {
      updatedDb = [...mainDb, ...toAdd];
      await savePflegeDatabase(updatedDb);
    }

    const categoryCounts = getCategoryCounts(updatedDb);

    if (toAdd.length > 0) {
      res.json({
        ok: true,
        added: toAdd.length,
        alreadyPresent,
        totalScraped: scraped.length,
        totalMainDb: updatedDb.length,
        categories: categoryCounts,
        message: `${toAdd.length} nouvel(s) email(s) ajouté(s) à la base du site avec succès ! (${alreadyPresent} déjà présents)`
      });
    } else {
      res.json({
        ok: true,
        added: 0,
        alreadyPresent,
        totalScraped: scraped.length,
        totalMainDb: updatedDb.length,
        categories: categoryCounts,
        message: `Les ${scraped.length} emails extraits sont déjà tous enregistrés dans la base du site (Total base: ${updatedDb.length} emails).`
      });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Download CSV of scraped emails
app.get('/api/scraper/ausbildung/download/csv', async (req, res) => {
  try {
    const csvPath = path.join(__dirname, 'ausbildung_emails.csv');
    const jsonPath = path.join(DATA_DIR, 'ausbildung_emails_database.json');

    if (!fs.existsSync(csvPath) && fs.existsSync(jsonPath)) {
      const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const header = 'Email,Name,Company,Phone,Website,Region,Category,AddedAt\n';
      const rows = records.map(r =>
        `"${r.email}","${(r.name || '').replace(/"/g, '""')}","${(r.company || '').replace(/"/g, '""')}","${r.phone || ''}","${r.website || ''}","${(r.region || '').replace(/"/g, '""')}","${(r.category || '').replace(/"/g, '""')}","${r.addedAt || ''}"`
      ).join('\n');
      fs.writeFileSync(csvPath, '\uFEFF' + header + rows, 'utf8');
    }

    if (!fs.existsSync(csvPath)) {
      return res.status(404).send('Fichier CSV introuvable. Lancez le scraper d\'abord.');
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ausbildung_emails_allemagne.csv"');
    res.sendFile(csvPath);
  } catch (e) {
    res.status(500).send('Erreur: ' + e.message);
  }
});

// Download JSON of scraped emails
app.get('/api/scraper/ausbildung/download/json', async (req, res) => {
  try {
    const jsonPath = path.join(DATA_DIR, 'ausbildung_emails_database.json');
    if (!fs.existsSync(jsonPath)) {
      return res.status(404).send('Fichier JSON introuvable. Lancez le scraper d\'abord.');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ausbildung_emails_allemagne.json"');
    res.sendFile(jsonPath);
  } catch (e) {
    res.status(500).send('Erreur: ' + e.message);
  }
});

/* ============================ Applications Tracker API ============================ */

// GET /api/applications - List tracked applications
app.get('/api/applications', async (req, res) => {
  try {
    const apps = await getApplicationsStore();
    res.json({ ok: true, applications: apps });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/applications - Add new application
app.post('/api/applications', async (req, res) => {
  try {
    const { company, position, city, email, phone, platform, offerUrl, status, notes, interviewDate } = req.body || {};
    if (!company && !email) {
      return res.status(400).json({ ok: false, error: 'Nom de l\'entreprise ou email requis.' });
    }
    const apps = await getApplicationsStore();
    const cleanComp = cleanGermanCompanyName(company || '', email || '');
    const now = new Date().toISOString();
    const newApp = {
      id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      userId: 'user',
      company: (company || cleanComp).trim(),
      cleanCompany: cleanComp,
      position: (position || 'Bewerbung / Ausbildung').trim(),
      city: (city || 'Deutschland').trim(),
      email: (email || '').trim(),
      phone: (phone || '').trim(),
      platform: (platform || 'Arbeitsagentur').trim(),
      offerUrl: (offerUrl || '').trim(),
      status: status || 'Gesendet',
      appliedDate: now,
      interviewDate: interviewDate || '',
      notes: (notes || '').trim(),
      history: [
        { status: status || 'Gesendet', date: now, notes: notes || 'Candidature enregistrée' }
      ]
    };
    apps.unshift(newApp);
    await saveApplicationsStore(apps);
    res.json({ ok: true, application: newApp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/applications/:id - Update status, notes, interviewDate
app.patch('/api/applications/:id', async (req, res) => {
  try {
    const appId = req.params.id;
    const { status, notes, interviewDate, company, position, city, email, phone } = req.body || {};
    const apps = await getApplicationsStore();
    
    const idx = apps.findIndex(a => a.id === appId);
    if (idx < 0) {
      return res.status(404).json({ ok: false, error: 'Candidature introuvable.' });
    }

    const appItem = apps[idx];
    const prevStatus = appItem.status;
    const now = new Date().toISOString();

    if (status && status !== prevStatus) {
      appItem.status = status;
      if (!appItem.history) appItem.history = [];
      appItem.history.push({
        status,
        date: now,
        notes: notes || `Statut changé de ${prevStatus} à ${status}`
      });
    }

    if (notes !== undefined) appItem.notes = notes;
    if (interviewDate !== undefined) appItem.interviewDate = interviewDate;
    if (company !== undefined) {
      appItem.company = company;
      appItem.cleanCompany = cleanGermanCompanyName(company, appItem.email);
    }
    if (position !== undefined) appItem.position = position;
    if (city !== undefined) appItem.city = city;
    if (email !== undefined) appItem.email = email;
    if (phone !== undefined) appItem.phone = phone;

    await saveApplicationsStore(apps);
    res.json({ ok: true, application: appItem });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/applications/:id - Delete application
app.delete('/api/applications/:id', async (req, res) => {
  try {
    const appId = req.params.id;
    let apps = await getApplicationsStore();
    
    const target = apps.find(a => a.id === appId);
    if (!target) {
      return res.status(404).json({ ok: false, error: 'Candidature introuvable.' });
    }

    apps = apps.filter(a => a.id !== appId);
    await saveApplicationsStore(apps);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================ Job Platforms Search (Arbeitsagentur & Azubiyo) ============================ */

app.all('/api/scraper/platforms/search', async (req, res) => {
  try {
    const params = req.method === 'POST' ? req.body : req.query;
    const field = params.field || params.berufsfeld || 'Pflege';
    const platforms = params.platforms || ['arbeitsagentur', 'azubiyo'];
    const location = params.location || params.ort || 'Bundesweit';
    const limit = Number(params.limit) || 30;

    const results = await searchJobPlatforms({
      field,
      platforms,
      location,
      limit
    });

    res.json({
      ok: true,
      count: results.length,
      field,
      location,
      platforms: Array.isArray(platforms) ? platforms : [platforms],
      results
    });
  } catch (e) {
    console.error('Error searching job platforms:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Endpoint /api/chat محمي بـ sanitize-html ضد هجمات XSS
app.post('/api/chat', (req, res) => {
  const rawMessage = req.body?.message || '';
  const cleanMessage = cleanInput(rawMessage);

  if (!cleanMessage) {
    return res.status(400).json({ ok: false, error: 'Le message ne peut pas être vide.' });
  }

  // إرجاع النص منقى وجاهز لإرساله لأي AI API
  res.json({
    ok: true,
    reply: 'Received safely: ' + cleanMessage,
    sanitized: cleanMessage
  });
});

// Endpoint /api/submit مع تنقية البيانات (Sanitization)
app.post('/api/submit', (req, res) => {
  const safeName = cleanInput(req.body?.name || '');
  const safeCvText = cleanInput(req.body?.cvText || '');

  res.json({
    ok: true,
    status: 'Success',
    name: safeName,
    cvText: safeCvText
  });
});

// JSON errors (multer size/type errors, bad JSON…)
app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'CV is larger than 10 MB.' : err.message;
  res.status(400).json({ ok: false, success: false, error: msg });
});

// Fallback for unmatched /api routes: ALWAYS return JSON 404 (never HTML!)
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, success: false, error: 'Endpoint API introuvable', message: 'Endpoint API introuvable' });
});

/* ============================ boot ============================ */

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

await initAdminGmail();

if (process.argv.includes('--verify')) {
  if (adminGmail.connected) console.log(`✅ SMTP OK — connected as ${adminGmail.email}`);
  else console.error(`❌ SMTP FAILED — ${adminGmail.error}`);
  process.exit(adminGmail.connected ? 0 : 1);
}

function startServer(port) {
  const server = app.listen(port, HOST, () => {
    const url = `http://0.0.0.0:${port}`;
    console.log('\n  🚀 Auto-CV Bulk Sender (REDESIGNED) running at ' + url);
    console.log('  🔐 Admin Email: ' + ADMIN_EMAIL);
    console.log('  🔐 Admin Password: ' + ADMIN_PASSWORD);
    console.log(adminGmail.connected
      ? `  ✅ Admin Gmail connected to ${adminGmail.email}`
      : `  ℹ️  Admin Gmail: ${adminGmail.error || 'Non connecté'}`);
    console.log('');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`  ⚠️  Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      throw e;
    }
  });
}

startServer(PORT);
