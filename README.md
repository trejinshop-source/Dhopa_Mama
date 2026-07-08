# 🧺 Dhopa Mama - সম্পূর্ণ ডিপ্লয়মেন্ট গাইড

## 📁 ফাইলসমূহ
- `server.js` - ব্যাকএন্ড API (Render এ ডিপ্লয় হবে)
- `package.json` - Node.js dependencies
- `.env` - Environment variables (MongoDB, JWT ইত্যাদি)
- `index.html` - কাস্টমার ওয়েবসাইট (Vercel এ ডিপ্লয়)
- `admin.html` - অ্যাডমিন প্যানেল (Vercel এ ডিপ্লয়)

---

## 🚀 STEP 1: Backend Render এ ডিপ্লয়

1. GitHub এ নতুন repo বানান, তাতে আপলোড করুন:
   - `server.js`
   - `package.json`
   - `.env` (⚠️ .gitignore এ যোগ করলে ভালো, Render এ ম্যানুয়ালি env variable set করবেন)

2. https://render.com এ যান → **New → Web Service**
3. GitHub repo connect করুন
4. সেটিংস:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. **Environment Variables** যোগ করুন (`.env` এর মতো):
   ```
   MONGODB_URI = mongodb+srv://dhopamama_db_user:ERtFkin4DK7Kmowr@cluster0.u2ujuku.mongodb.net/Dhopa_Mama?appName=Cluster0
   JWT_SECRET = dhopa_mama_super_secret_key_change_this_in_production_2026
   ADMIN_EMAIL = admin@dhopamama.com
   ADMIN_PASSWORD = Admin@123456
   NODE_ENV = production
   CORS_ORIGIN = *
   ```
6. Deploy → URL কপি করুন (যেমন: `https://dhopa-mama-j75g.onrender.com`)

---

## 🌐 STEP 2: Frontend Vercel এ ডিপ্লয়

1. `index.html` ও `admin.html` এ **API_URL** পরিবর্তন করুন:
   ```js
   const API_URL = 'https://dhopa-mama-j75g.onrender.com';
   ```
2. https://vercel.com এ যান → **Add New Project**
3. দুটি ফাইল GitHub repo বা সরাসরি drag-drop এ আপলোড
4. Deploy → হয়ে গেল ✅

---

## 🔐 Default Admin Login
- **Email:** admin@dhopamama.com
- **Password:** Admin@123456

⚠️ প্রথম লগইনের পর MongoDB তে পাসওয়ার্ড পরিবর্তন করে নিন।

---

## 🧪 লোকাল টেস্ট
```bash
npm install
node server.js
```
তারপর `index.html` ও `admin.html` ব্রাউজারে ওপেন করুন (API_URL = `http://localhost:5000` রাখুন)।

---

## 📡 API Endpoints
- `GET /api/services` - সার্ভিস লিস্ট
- `POST /api/orders` - অর্ডার তৈরি
- `GET /api/orders/track/:query` - অর্ডার ট্র্যাক
- `POST /api/contact` - কন্ট্যাক্ট ফর্ম
- `POST /api/admin/login` - অ্যাডমিন লগইন
- `GET /api/admin/stats` - ড্যাশবোর্ড স্ট্যাটস
- `GET/PUT/DELETE /api/admin/orders` - অর্ডার ম্যানেজমেন্ট
- `GET/POST/PUT/DELETE /api/admin/services` - সার্ভিস ম্যানেজমেন্ট
- `GET/PUT/DELETE /api/admin/contacts` - মেসেজ ম্যানেজমেন্ট
