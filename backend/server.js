/**
 * Dhopa Mama / Falaq Laundry — Backend API
 * Stack: Express + MongoDB (Mongoose)
 * Deploy: Render.com (Web Service, Node)
 *
 * Environment variables (Render → Environment):
 *   MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD,
 *   ALLOWED_ORIGINS (comma-separated), PORT (Render auto-sets)
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '5mb' }));

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
  txn:             String
}, { timestamps: true });
const Order = mongoose.model('Order', OrderSchema, 'orders');

const UserSchema = new mongoose.Schema({
  name:     String,
  contact:  { type: String, index: true },
  password: String
}, { timestamps: true });
const User = mongoose.model('User', UserSchema, 'users');

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

/* ---------------- Admin auth ---------------- */
function signAdminToken() {
  return jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'dev', { expiresIn: '30d' });
}
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET || 'dev');
    if (p.role !== 'admin') throw new Error('bad role');
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
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

/* ---------------- Bucket collections (products, categories, services, settings) ---------------- */
function bucketRoutes(path, Model) {
  app.get(`/api/${path}`, async (_req, res) => {
    try { const b = await getBucket(Model); res.json(b.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Admin overwrites the whole array/object (matches admin panel's saveData behavior)
  app.put(`/api/${path}`, async (req, res) => {
    try { const b = await putBucket(Model, req.body); res.json(b.data); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
bucketRoutes('products',   Products);
bucketRoutes('categories', Categories);
bucketRoutes('services',   Services);
bucketRoutes('settings',   Settings);

/* ---------------- Orders ---------------- */
// Public: list (admin panel reads this)
app.get('/api/orders', async (_req, res) => {
  const list = await Order.find().sort({ createdAt: -1 }).lean();
  res.json(list);
});
// Public: place order (from index.html checkout)
app.post('/api/orders', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) body.id = 'ORD' + Date.now();
    const doc = await Order.findOneAndUpdate(
      { id: body.id }, { $set: body }, { upsert: true, new: true }
    );
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: bulk replace (admin panel saveData(LS.orders, orders))
app.put('/api/orders', async (req, res) => {
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
app.patch('/api/orders/:id', async (req, res) => {
  const doc = await Order.findOneAndUpdate({ id: req.params.id }, { $set: req.body }, { new: true });
  res.json(doc);
});
app.delete('/api/orders/:id', async (req, res) => {
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
    if (exists) return res.status(409).json({ error: 'Already registered' });
    const hash = await bcrypt.hash(password, 10);
    const u = await User.create({ name: name || contact, contact, password: hash });
    res.json({ id: u._id, name: u.name, contact: u.contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { contact, password } = req.body || {};
    const u = await User.findOne({ contact });
    if (!u) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, u.password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    res.json({ id: u._id, name: u.name, contact: u.contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: bulk replace users list (matches admin panel behavior)
app.put('/api/users', async (req, res) => {
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

// silence unused warning
void requireAdmin;
