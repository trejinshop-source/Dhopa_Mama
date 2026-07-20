/**
 * Dhopa Mama — Backend API
 * Stack: Express + MongoDB (Mongoose) + Cloudinary + JWT + bcrypt
 * Replit: serves on process.env.PORT (8080)
 * Also serves static frontend (/) and admin panel (/admin/)
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');

const app = express();

/* ── Body parsing ── */
app.use(express.json({ limit: '25mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large — image too big.' });
  }
  next(err);
});

/* ── Cloudinary ── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

/* ── CORS (permissive for Replit dev) ── */
app.use(cors({ origin: true, credentials: true }));

/* ── Static files: admin panel at /admin ── */
const ADMIN_DIR = path.join(__dirname, 'public', 'admin');
if (fs.existsSync(ADMIN_DIR)) {
  app.use('/admin', express.static(ADMIN_DIR));
  app.get('/admin', (_req, res) => res.sendFile(path.join(ADMIN_DIR, 'admin.html')));
}

/* ── Static files: frontend at / (served AFTER /api and /admin routes) ── */
const FRONTEND_DIR = path.join(__dirname, 'public', 'frontend');

/* ── Google Apps Script email notification ── */
async function notifyOrderByEmail(order) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
  } catch (e) {
    console.error('Order email webhook failed:', e.message);
  }
}

/* ── MongoDB ── */
mongoose.set('strictQuery', true);
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));
} else {
  console.warn('⚠️  MONGODB_URI not set — DB features disabled');
}

/* ── Schemas ── */
const BucketSchema = new mongoose.Schema({
  key:  { type: String, unique: true, default: 'main' },
  data: { type: mongoose.Schema.Types.Mixed, default: [] }
}, { timestamps: true });

const Products   = mongoose.model('Products',   BucketSchema, 'products');
const Categories = mongoose.model('Categories', BucketSchema, 'categories');
const Services   = mongoose.model('Services',   BucketSchema, 'services');
const Settings   = mongoose.model('Settings', new mongoose.Schema({
  key:  { type: String, unique: true, default: 'main' },
  data: { type: mongoose.Schema.Types.Mixed, default: { bkash: '01700-000000', nagad: '01800-000000' } }
}, { timestamps: true }), 'settings');

const OrderSchema = new mongoose.Schema({
  id:              { type: String, index: true, unique: true },
  items:           { type: Array, default: [] },
  total:           { type: Number, default: 0 },
  date:            String,
  time:            String,
  method:          String,
  status:          { type: String, default: 'Pending' },
  customerName:    String,
  customerMobile:  String,
  customerAddress: String,
  txn:             String,
  userId:          { type: String, index: true },
  userContact:     { type: String, index: true }
}, { timestamps: true });
const Order = mongoose.model('Order', OrderSchema, 'orders');

const UserSchema = new mongoose.Schema({
  name:     String,
  contact:  { type: String, index: true },
  password: String
}, { timestamps: true });
const User = mongoose.model('User', UserSchema, 'users');

const VisitEventSchema = new mongoose.Schema({
  ts:   { type: Date, default: Date.now, index: true },
  page: String,
  ref:  String
});
const VisitEvent = mongoose.model('VisitEvent', VisitEventSchema, 'visit_events');

const ClickEventSchema = new mongoose.Schema({
  ts:          { type: Date, default: Date.now, index: true },
  type:        { type: String, default: 'product_view' },
  productId:   String,
  productName: String
});
const ClickEvent = mongoose.model('ClickEvent', ClickEventSchema, 'click_events');

/* ── Bucket helpers ── */
async function getBucket(Model) {
  let doc = await Model.findOne({ key: 'main' });
  if (!doc) doc = await Model.create({ key: 'main', data: Model === Settings ? undefined : [] });
  return doc;
}
async function putBucket(Model, data) {
  return Model.findOneAndUpdate(
    { key: 'main' }, { $set: { data } }, { upsert: true, new: true }
  );
}

/* ── Auth helpers ── */
const SECRET = process.env.JWT_SECRET || 'dhopa-mama-dev-secret-change-in-prod';
function signAdminToken() {
  return jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '365d' });
}
function signUserToken(u) {
  return jwt.sign({ role: 'user', id: String(u._id), contact: u.contact, name: u.name }, SECRET, { expiresIn: '365d' });
}
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.role !== 'admin') throw new Error('bad role');
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}
function requireUser(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.role !== 'user') throw new Error('bad role');
    req.user = p;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}
function optionalUser(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try {
      const p = jwt.verify(token, SECRET);
      if (p.role === 'user') req.user = p;
    } catch (e) { /* ignore */ }
  }
  next();
}
function optionalAdmin(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  req.isAdmin = false;
  if (token) {
    try {
      const p = jwt.verify(token, SECRET);
      if (p.role === 'admin') req.isAdmin = true;
    } catch (e) { /* ignore — treat as public/non-admin request */ }
  }
  next();
}

/* ════════════════════════════════════════════
   API ROUTES
   ════════════════════════════════════════════ */

/* Health */
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

/* Admin login */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = process.env.ADMIN_USERNAME || 'admin';
  const p = process.env.ADMIN_PASSWORD || 'admin123';
  if (username === u && password === p) {
    return res.json({ token: signAdminToken() });
  }
  return res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড।' });
});

/* Cloudinary upload (admin only) */
app.post('/api/upload', requireAdmin, async (req, res) => {
  try {
    const { image, folder } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image (dataURL) required' });
    const result = await cloudinary.uploader.upload(image, {
      folder: folder || 'dhopa-mama',
      resource_type: 'image'
    });
    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

/* Bucket routes (products, categories, services, settings)
   GET: admin (valid Bearer admin token) সব আইটেম দেখে — disabled সহ, যাতে
   অ্যাডমিন প্যানেলে টগল করে আবার চালু করা যায়। কিন্তু public/frontend
   রিকোয়েস্টে (কোনো admin token ছাড়া) enabled:false থাকা আইটেম বাদ দিয়ে
   পাঠানো হয় — অর্থাৎ অ্যাডমিন প্যানেল থেকে ডিসেবল করলেই তা ফ্রন্টএন্ড থেকে
   সার্ভার লেভেলেই বাদ পড়ে যাবে। */
function bucketRoutes(path, Model) {
  app.get(`/api/${path}`, optionalAdmin, async (req, res) => {
    try {
      const b = await getBucket(Model);
      let data = b.data;
      if (!req.isAdmin && Array.isArray(data)) {
        data = data.filter(item => !item || item.enabled !== false);
      }
      res.json(data);
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put(`/api/${path}`, requireAdmin, async (req, res) => {
    try { const b = await putBucket(Model, req.body); res.json(b.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
bucketRoutes('products',   Products);
bucketRoutes('categories', Categories);
bucketRoutes('services',   Services);
bucketRoutes('settings',   Settings);

/* Analytics */
app.post('/api/track/visit', async (req, res) => {
  try {
    const { page, ref } = req.body || {};
    await VisitEvent.create({ page: page || '/', ref: ref || '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/track/click', async (req, res) => {
  try {
    const { type, productId, productName } = req.body || {};
    if (!productName) return res.status(400).json({ error: 'productName required' });
    await ClickEvent.create({ type: type || 'product_view', productId: productId || '', productName });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/analytics/summary', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startWeek  = new Date(startToday); startWeek.setDate(startWeek.getDate() - 6);
    const startAllTime = new Date(0);
    const visitCount = (since) => VisitEvent.countDocuments({ ts: { $gte: since } });
    const topProducts = (since, limit = 8) => ClickEvent.aggregate([
      { $match: { ts: { $gte: since } } },
      { $group: { _id: '$productName', clicks: { $sum: 1 } } },
      { $sort: { clicks: -1 } },
      { $limit: limit }
    ]);
    const [visitsToday, visitsWeek, visitsAll, topToday, topWeek, topAll] = await Promise.all([
      visitCount(startToday), visitCount(startWeek), visitCount(startAllTime),
      topProducts(startToday), topProducts(startWeek), topProducts(startAllTime)
    ]);
    res.json({
      visitsToday, visitsWeek, visitsAll,
      topToday: topToday.map(x => ({ name: x._id || 'অজানা', clicks: x.clicks })),
      topWeek:  topWeek.map(x  => ({ name: x._id || 'অজানা', clicks: x.clicks })),
      topAll:   topAll.map(x   => ({ name: x._id || 'অজানা', clicks: x.clicks }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Orders */
app.get('/api/orders', requireAdmin, async (_req, res) => {
  try { const list = await Order.find().sort({ createdAt: -1 }).lean(); res.json(list); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/my-orders', requireUser, async (req, res) => {
  try {
    const or = [{ userId: req.user.id }];
    if (req.user.contact) or.push({ userContact: req.user.contact });
    const list = await Order.find({ $or: or }).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/orders', optionalUser, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) body.id = 'ORD' + Date.now();
    if (req.user) {
      body.userId = req.user.id;
      body.userContact = req.user.contact;
      if (!body.customerName) body.customerName = req.user.name;
    }
    const doc = await Order.findOneAndUpdate(
      { id: body.id }, { $set: body }, { upsert: true, new: true }
    );
    notifyOrderByEmail(doc.toObject ? doc.toObject() : doc);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/orders', requireAdmin, async (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [];
    for (const o of arr) {
      if (!o || !o.id) continue;
      await Order.findOneAndUpdate({ id: o.id }, { $set: o }, { upsert: true });
    }
    const list = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await Order.findOneAndUpdate({ id: req.params.id }, { $set: req.body }, { new: true });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try { await Order.deleteOne({ id: req.params.id }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* Users */
app.get('/api/users', requireAdmin, async (_req, res) => {
  try {
    const list = await User.find().sort({ createdAt: -1 }).select('-password').lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/register', async (req, res) => {
  try {
    const { name, contact, password } = req.body || {};
    if (!contact || !password) return res.status(400).json({ error: 'contact ও password দিন।' });
    const exists = await User.findOne({ contact });
    if (exists) return res.status(409).json({ error: 'এই নাম্বার/ইমেইল দিয়ে আগে থেকেই রেজিস্টার করা আছে। লগইন করুন।' });
    const hash = await bcrypt.hash(password, 10);
    const u = await User.create({ name: name || contact, contact, password: hash });
    res.json({ id: u._id, name: u.name, contact: u.contact, token: signUserToken(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { contact, password } = req.body || {};
    const u = await User.findOne({ contact });
    if (!u) return res.status(401).json({ error: 'একাউন্ট খুঁজে পাওয়া যায়নি। আগে রেজিস্টার করুন।' });
    const ok = await bcrypt.compare(password, u.password || '');
    if (!ok) return res.status(401).json({ error: 'পাসওয়ার্ড ভুল হয়েছে।' });
    res.json({ id: u._id, name: u.name, contact: u.contact, token: signUserToken(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/me', requireUser, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).select('-password').lean();
    if (!u) return res.status(401).json({ error: 'User not found' });
    res.json({ id: u._id, name: u.name, contact: u.contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/users', requireAdmin, async (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [];
    for (const u of arr) {
      if (!u || !u.contact) continue;
      await User.findOneAndUpdate({ contact: u.contact }, { $set: { name: u.name, contact: u.contact } }, { upsert: true });
    }
    const list = await User.find().sort({ createdAt: -1 }).select('-password').lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Update user profile (logged-in user) */
app.patch('/api/me', requireUser, async (req, res) => {
  try {
    const { name, contact } = req.body || {};
    const update = {};
    if (name) update.name = name;
    if (contact) update.contact = contact;
    const u = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select('-password');
    res.json({ id: u._id, name: u.name, contact: u.contact, token: signUserToken(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Change password (logged-in user) */
app.post('/api/change-password', requireUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'সব ফিল্ড পূরণ করুন।' });
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'ইউজার নেই।' });
    const ok = await bcrypt.compare(oldPassword, u.password || '');
    if (!ok) return res.status(401).json({ error: 'বর্তমান পাসওয়ার্ড ভুল।' });
    u.password = await bcrypt.hash(newPassword, 10);
    await u.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Forgot / Reset Password */
const OTP_STORE = new Map();
function generateOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
async function sendOtpEmail(to, otp) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) throw new Error('APPS_SCRIPT_URL not set');
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'otp', to, otp })
  });
}
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, contact } = req.body || {};
    const id = email || contact;
    if (!id) return res.status(400).json({ error: 'email বা contact required' });
    const u = await User.findOne({ contact: id });
    const otp = generateOtp();
    OTP_STORE.set(id, { otp, expiresAt: Date.now() + 15 * 60 * 1000 });
    if (u) { try { await sendOtpEmail(id, otp); } catch(e){} }
    res.json({ ok: true, message: 'যদি এই ইমেইলে অ্যাকাউন্ট থাকে, OTP পাঠানো হয়েছে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, contact, otp, newPassword } = req.body || {};
    const id = email || contact;
    if (!id || !otp || !newPassword) return res.status(400).json({ error: 'সব ফিল্ড পূরণ করুন' });
    const rec = OTP_STORE.get(id);
    if (!rec || rec.otp !== String(otp) || rec.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'OTP ভুল অথবা মেয়াদ শেষ' });
    }
    const u = await User.findOne({ contact: id });
    if (!u) return res.status(404).json({ error: 'ইউজার নেই' });
    u.password = await bcrypt.hash(newPassword, 10);
    await u.save();
    OTP_STORE.delete(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Top Friend status */
function tierPercent(count) {
  if (count >= 50) return 50;
  if (count >= 30) return 10;
  if (count >= 20) return 5;
  return 0;
}
app.get('/api/top-friend/status', requireUser, async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const or = [{ userId: req.user.id }];
    if (req.user.contact) or.push({ userContact: req.user.contact });
    const count = await Order.countDocuments({ $or: or, createdAt: { $gte: start } });
    res.json({
      monthlyOrderCount: count,
      discountPercent: tierPercent(count),
      isTopFriend: count >= 20,
      month: (now.getMonth() + 1) + '/' + now.getFullYear()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════
   STATIC FILES (frontend & admin)
   Must come AFTER all /api routes
   ════════════════════════════════════════════ */
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  // SPA fallback: serve index.html for any unmatched route (excluding /api and /admin)
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) return res.status(404).json({ error: 'Not found' });
    const file = path.join(FRONTEND_DIR, req.path);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return res.sendFile(file);
    }
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

/* ── Start ── */
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Dhopa Mama API + Frontend on :${PORT}`));