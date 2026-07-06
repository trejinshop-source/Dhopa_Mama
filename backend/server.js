/**
 * Dhopa Mama / Falaq Laundry — Backend API
 * Stack: Express + MongoDB (Mongoose) + Cloudinary
 * Deploy: Render.com (Web Service, Node)
 *
 * Environment variables (Render → Environment):
 *   MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD,
 *   ALLOWED_ORIGINS (comma-separated), PORT (Render auto-sets),
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *
 * ---------------------------------------------------------------------
 * DATA MODEL (updated)
 * ---------------------------------------------------------------------
 * Products / Categories / Services used to be stored as ONE MongoDB
 * document containing the whole array (a "bucket"). That hits MongoDB's
 * hard 16MB-per-document limit once enough items/images pile up, and any
 * save of the whole array then fails with a 500 error.
 *
 * Now each product / category / service is its OWN MongoDB document in
 * its own collection. The public API shape is unchanged (GET returns an
 * array, admin PUT replaces the whole array) so the admin panel and the
 * storefront do not need to change how they talk to the API — internally
 * we just fan the array out into many small documents instead of one big
 * one. This removes the size ceiling entirely.
 *
 * Images: every image field (product/category img) must be a Cloudinary
 * secure_url (set via POST /api/upload from the admin panel). Nothing is
 * ever stored as base64 in MongoDB — only plain URL strings.
 *
 * On first boot after this update, any pre-existing old-style bucket
 * document (key:'main', data:[...]) is automatically migrated into the
 * new per-item documents, then removed. This is safe to deploy directly
 * on top of your existing database — no manual migration step needed.
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json({ limit: '10mb' })); // generous: bodies should now only ever contain URLs + text, never base64
// Clear JSON error instead of a raw connection failure when a request body is too large
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large. Images must be uploaded via /api/upload (Cloudinary) first, not sent as base64.' });
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
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowed.length === 0) return cb(null, true); // dev fallback
    if (allowed.includes(origin)) return cb(null, true);
    return cb(null, true); // permissive; tighten later if needed
  },
  credentials: true
}));

/* ---------------- MongoDB ---------------- */
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => { console.log('✅ MongoDB connected'); migrateLegacyBuckets(); })
  .catch(err => console.error('❌ MongoDB error:', err.message));

/* ---------------- Schemas ---------------- */
// Loose schema: each document IS an item (a product / category / service).
// `strict:false` lets the admin panel's existing field names (t, cat, n, key,
// icon, img, services, title, short, price, ...) pass through unchanged.
const ItemSchema = new mongoose.Schema({}, { strict: false, timestamps: true });

const Products   = mongoose.model('Products',   ItemSchema, 'products');
const Categories = mongoose.model('Categories', ItemSchema, 'categories');
const Services   = mongoose.model('Services',   ItemSchema, 'services');

// Settings stays as a small singleton document (bkash/nagad numbers etc — never large)
const Settings = mongoose.model('Settings', new mongoose.Schema({
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

/* ---------------- One-time legacy migration ----------------
 * If products/categories/services collections still contain the OLD
 * bucket-style document ({ key:'main', data:[...] }), unpack it into
 * individual item documents, then delete the old bucket doc.
 */
async function migrateLegacyBuckets() {
  const collections = [
    { name: 'products',   Model: Products },
    { name: 'categories', Model: Categories },
    { name: 'services',   Model: Services }
  ];
  for (const { name, Model } of collections) {
    try {
      const legacy = await Model.findOne({ key: 'main' }).lean();
      if (legacy && Array.isArray(legacy.data)) {
        console.log(`↻ Migrating legacy "${name}" bucket (${legacy.data.length} items) to per-item documents...`);
        if (legacy.data.length) {
          await Model.insertMany(legacy.data.map(item => ({ ...item })));
        }
        await Model.deleteOne({ _id: legacy._id });
        console.log(`✅ Migrated "${name}".`);
      }
    } catch (e) {
      console.error(`Legacy migration for ${name} failed:`, e.message);
    }
  }
}

/* ---------------- Helpers: item collections ---------------- */
// Strip internal Mongo fields before sending to the frontend so shape matches
// exactly what the admin panel / storefront already expect.
function clean(doc) {
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest;
}
async function getArray(Model) {
  const docs = await Model.find({ key: { $ne: 'main' } }).sort({ createdAt: 1 }).lean();
  return docs.map(clean);
}
async function replaceArray(Model, arr) {
  const items = Array.isArray(arr) ? arr : [];
  await Model.deleteMany({});
  if (items.length) await Model.insertMany(items.map(x => ({ ...x })));
  return getArray(Model);
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
 * This is the ONLY place an image ever gets uploaded — the returned URL is
 * what gets stored in MongoDB. Base64 never touches the products/categories
 * collections themselves.
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

/* ---------------- Products / Categories / Services (now per-item documents) ---------------- */
function itemRoutes(path, Model) {
  app.get(`/api/${path}`, async (_req, res) => {
    try { res.json(await getArray(Model)); }
    catch (e) { console.error(`GET /api/${path} failed:`, e.message); res.status(500).json({ error: e.message }); }
  });
  // Admin overwrites the whole list (matches admin panel's saveData behavior) —
  // internally this becomes a clean replace of many small documents, not one big one.
  app.put(`/api/${path}`, requireAdmin, async (req, res) => {
    try { res.json(await replaceArray(Model, req.body)); }
    catch (e) {
      console.error(`PUT /api/${path} failed:`, e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });
}
itemRoutes('products',   Products);
itemRoutes('categories', Categories);
itemRoutes('services',   Services);

/* ---------------- Settings (small singleton, unchanged) ---------------- */
async function getSettings() {
  let doc = await Settings.findOne({ key: 'main' });
  if (!doc) doc = await Settings.create({ key: 'main' });
  return doc;
}
app.get('/api/settings', async (_req, res) => {
  try { const s = await getSettings(); res.json(s.data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const s = await Settings.findOneAndUpdate({ key: 'main' }, { $set: { data: req.body } }, { upsert: true, new: true });
    res.json(s.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- Orders ---------------- */
app.get('/api/orders', async (_req, res) => {
  const list = await Order.find().sort({ createdAt: -1 }).lean();
  res.json(list);
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

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Dhopa Mama API on :${PORT}`));