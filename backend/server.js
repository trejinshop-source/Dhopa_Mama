/**
 * Dhopa Mama / Dhopa Mama — Backend API
 * Stack: Express + MongoDB (Mongoose) + Cloudinary
 * Deploy: Render.com (Web Service, Node)
 *
 * Environment variables (Render → Environment):
 *   MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD,
 *   ALLOWED_ORIGINS (comma-separated), PORT (Render auto-sets),
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json({ limit: '25mb' }));
// Return a clear JSON error instead of a raw connection failure when a
// request body is too large (this is what most "network/CORS" save errors
// on the admin panel actually are, once legacy base64 images pile up).
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large — run the image migration script to move remaining base64 images to Cloudinary.' });
  }
  next(err);
});

/* ---------------- Cloudinary ---------------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

/* ---------------- CORS ---------------- */
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    // allow tools like curl / server-to-server (no origin) and configured origins
    if (!origin) return cb(null, true);
    if (allowed.length === 0) return cb(null, true); // dev fallback
    if (allowed.includes(origin)) return cb(null, true);
    return cb(null, true); // permissive; tighten later if needed
  },
  credentials: true
}));


/* ---------------- Google Apps Script order email ----------------
 * প্রতিটি নতুন অর্ডার Apps Script webhook-এ পাঠানো হয়, যা
 * trejin.shop@gmail.com এ ইমেইল পাঠায় (Code.gs দেখুন)।
 * Render → Environment এ APPS_SCRIPT_URL সেট করুন (Web App deploy URL)।
 */
async function notifyOrderByEmail(order) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    console.log('Order email webhook sent:', order.id);
  } catch (e) {
    console.error('Order email webhook failed:', e.message);
  }
}

/* ---------------- MongoDB ---------------- */
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

/* ---------------- Schemas ----------------
 * সব collection-এ একটি করে "singleton doc" রাখা হয়েছে (key: 'main') যেখানে
 * পুরো array সংরক্ষিত। এভাবে admin panel-এর বর্তমান localStorage-based
 * ফরম্যাটের সাথে ১:১ ম্যাচ করে কাজ করা যায়।
 */
const BucketSchema = new mongoose.Schema({
  key:  { type: String, unique: true, default: 'main' },
  data: { type: mongoose.Schema.Types.Mixed, default: [] }
}, { timestamps: true });

const Products    = mongoose.model('Products',    BucketSchema, 'products');
const Categories  = mongoose.model('Categories',  BucketSchema, 'categories');
const Services    = mongoose.model('Services',    BucketSchema, 'services');
const Settings    = mongoose.model('Settings',    new mongoose.Schema({
  key: { type: String, unique: true, default: 'main' },
  data: { type: mongoose.Schema.Types.Mixed, default: { bkash:'01700-000000', nagad:'01800-000000' } }
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

/* ---------------- Analytics: site visits + product clicks ----------------
 * এডমিন প্যানেলের "Analytics" ট্যাবে দেখানোর জন্য — কোন প্রোডাক্টে কতজন
 * ক্লিক করলো, আজকে/এই সপ্তাহে/সর্বমোট কতজন সাইট ভিজিট করলো ইত্যাদি।
 * এটি Google Analytics (GA4, gtag) এর পাশাপাশি কাজ করে — ইনডেক্স পেজে GA4
 * ইভেন্টও পাঠানো হয় (real GA4 ড্যাশবোর্ডে দেখার জন্য), আর এখানে নিজস্ব
 * MongoDB-ভিত্তিক দ্রুত সারাংশ রাখা হয় যাতে এডমিন প্যানেলে সরাসরি লাইভ
 * পরিসংখ্যান দেখানো যায় (কোনো Google service-account credential ছাড়াই)।
 */
const VisitEventSchema = new mongoose.Schema({
  ts:   { type: Date, default: Date.now, index: true },
  page: String,
  ref:  String
});
const VisitEvent = mongoose.model('VisitEvent', VisitEventSchema, 'visit_events');

const ClickEventSchema = new mongoose.Schema({
  ts:          { type: Date, default: Date.now, index: true },
  type:        { type: String, default: 'product_view' }, // product_view | add_to_cart
  productId:   String,
  productName: String
});
const ClickEvent = mongoose.model('ClickEvent', ClickEventSchema, 'click_events');

/* ---------------- Helpers ---------------- */
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

/* ---------------- Auth: tokens ---------------- */
const SECRET = process.env.JWT_SECRET || 'dev';
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
// Optional user — attaches req.user if a valid user token is present, else continues
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

/* ---------------- Routes: health ---------------- */
app.get('/', (_req, res) => res.json({ ok: true, service: 'Dhopa Mama API' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------------- Admin login ---------------- */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ token: signAdminToken() });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

/* ---------------- Cloudinary image upload (admin only) ----------------
 * Body: { image: "data:image/png;base64,...." , folder?: "dhopa-mama" }
 * Returns: { url, public_id }
 */
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

/* ---------------- Bucket collections (products, categories, services, settings) ---------------- */
function bucketRoutes(path, Model) {
  app.get(`/api/${path}`, async (_req, res) => {
    try { const b = await getBucket(Model); res.json(b.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Admin overwrites the whole array/object (matches admin panel's saveData behavior)
  app.put(`/api/${path}`, requireAdmin, async (req, res) => {
    try { const b = await putBucket(Model, req.body); res.json(b.data); }
    catch (e) {
      console.error(`PUT /api/${path} failed:`, e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });
}
bucketRoutes('products',   Products);
bucketRoutes('categories', Categories);
bucketRoutes('services',   Services);
bucketRoutes('settings',   Settings);

/* ---------------- Analytics routes ---------------- */
// Public (called from index.html): এক পেজ ভিজিট রেকর্ড করে
app.post('/api/track/visit', async (req, res) => {
  try {
    const { page, ref } = req.body || {};
    await VisitEvent.create({ page: page || '/', ref: ref || '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Public (called from index.html): প্রোডাক্ট ক্লিক / অ্যাড-টু-কার্ট রেকর্ড করে
app.post('/api/track/click', async (req, res) => {
  try {
    const { type, productId, productName } = req.body || {};
    if (!productName) return res.status(400).json({ error: 'productName required' });
    await ClickEvent.create({ type: type || 'product_view', productId: productId || '', productName });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin only: এডমিন প্যানেলের Analytics ট্যাবের জন্য সারাংশ — আজকে/সপ্তাহ/সর্বমোট
// ভিজিট সংখ্যা এবং সবচেয়ে বেশি ক্লিক পড়া প্রোডাক্টের তালিকা।
app.get('/api/analytics/summary', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startWeek = new Date(startToday); startWeek.setDate(startWeek.getDate() - 6);
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

/* ---------------- Orders ---------------- */
// Public: list (admin panel reads this)
app.get('/api/orders', async (_req, res) => {
  const list = await Order.find().sort({ createdAt: -1 }).lean();
  res.json(list);
});
// Logged-in user: only their own orders (with status)
app.get('/api/my-orders', requireUser, async (req, res) => {
  try {
    const or = [{ userId: req.user.id }];
    if (req.user.contact) or.push({ userContact: req.user.contact });
    const list = await Order.find({ $or: or }).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Place order (from index.html checkout). If user token present, links order to user.
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
    // নতুন অর্ডার এলেই Apps Script-এর মাধ্যমে জিমেইলে পাঠানো (fire-and-forget)
    notifyOrderByEmail(doc.toObject ? doc.toObject() : doc);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: bulk replace (admin panel saveData(LS.orders, orders))
app.put('/api/orders', requireAdmin, async (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [];
    // upsert each; do not delete missing (safer)
    for (const o of arr) {
      if (!o || !o.id) continue;
      await Order.findOneAndUpdate({ id: o.id }, { $set: o }, { upsert: true });
    }
    const list = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: update single order status
app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  const doc = await Order.findOneAndUpdate({ id: req.params.id }, { $set: req.body }, { new: true });
  res.json(doc);
});
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  await Order.deleteOne({ id: req.params.id });
  res.json({ ok: true });
});

/* ---------------- Users ---------------- */
app.get('/api/users', async (_req, res) => {
  const list = await User.find().sort({ createdAt: -1 }).select('-password').lean();
  res.json(list);
});
// Register → saves to MongoDB and returns a long-lived token (stays logged in)
app.post('/api/register', async (req, res) => {
  try {
    const { name, contact, password } = req.body || {};
    if (!contact || !password) return res.status(400).json({ error: 'contact & password required' });
    const exists = await User.findOne({ contact });
    if (exists) return res.status(409).json({ error: 'এই নাম্বার/ইমেইল দিয়ে আগে থেকেই রেজিস্টার করা আছে। লগইন করুন।' });
    const hash = await bcrypt.hash(password, 10);
    const u = await User.create({ name: name || contact, contact, password: hash });
    res.json({ id: u._id, name: u.name, contact: u.contact, token: signUserToken(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Login → returns a long-lived token
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
// Current user info from token (used to keep session alive on page load)
app.get('/api/me', requireUser, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).select('-password').lean();
    if (!u) return res.status(401).json({ error: 'User not found' });
    res.json({ id: u._id, name: u.name, contact: u.contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: bulk replace users list (matches admin panel behavior)
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


/* ---------------- Forgot Password (Gmail OTP via Apps Script) ---------------- */
// এই সিস্টেম বর্তমান APPS_SCRIPT_URL ব্যবহার করে OTP ইমেইল পাঠায়।
// Apps Script-এ পাঠানো পেলোডে { type: 'otp', to, otp } থাকে —
// Code.gs-এ doPost অংশটি এই টাইপ হ্যান্ডেল করার জন্য আপডেট করতে হবে (নিচে নমুনা দেওয়া হয়েছে)।
const OTP_STORE = new Map(); // email -> { otp, expiresAt }

function generateOtp(){
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(to, otp){
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) throw new Error('APPS_SCRIPT_URL not set');
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'otp', to, otp })
    });
  } catch(e) {
    console.error('sendOtpEmail failed:', e.message);
    throw e;
  }
}

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    // ইউজার আছে কিনা যাচাই — না থাকলেও same response (email enumeration prevent)
    const u = await User.findOne({ contact: email });
    const otp = generateOtp();
    OTP_STORE.set(email, { otp, expiresAt: Date.now() + 15 * 60 * 1000 }); // 15 মিনিট
    if (u) {
      try { await sendOtpEmail(email, otp); } catch(e){ /* still respond ok */ }
    }
    res.json({ ok: true, message: 'যদি এই ইমেইলে অ্যাকাউন্ট থাকে, OTP পাঠানো হয়েছে।' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!email || !otp || !newPassword) return res.status(400).json({ error: 'সব ফিল্ড পূরণ করুন' });
    const rec = OTP_STORE.get(email);
    if (!rec || rec.otp !== String(otp) || rec.expiresAt < Date.now()){
      return res.status(400).json({ error: 'OTP ভুল অথবা মেয়াদ শেষ' });
    }
    const u = await User.findOne({ contact: email });
    if (!u) return res.status(404).json({ error: 'ইউজার নেই' });
    u.password = await bcrypt.hash(newPassword, 10);
    await u.save();
    OTP_STORE.delete(email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- Top Friend: মাসিক অর্ডার কাউন্ট ও ডিসকাউন্ট ----------------
 * নিয়ম: চলতি মাসে ২০+ অর্ডার = ৫%, ৩০+ = ১০%, ৫০+ = ৫০% (সবকটি পরের অর্ডারে)
 * মাস শেষ হলে অটো রিসেট। */
function tierPercent(count){
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
    const count = await Order.countDocuments({
      $or: or,
      createdAt: { $gte: start }
    });
    res.json({
      monthlyOrderCount: count,
      discountPercent: tierPercent(count),
      isTopFriend: count >= 20,
      month: (now.getMonth()+1) + '/' + now.getFullYear()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Dhopa Mama API on :${PORT}`));