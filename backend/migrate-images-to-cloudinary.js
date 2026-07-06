/**
 * migrate-images-to-cloudinary.js
 *
 * ONE-TIME SCRIPT: Finds any product/category/service image fields that are
 * still stored as raw base64 data URLs (data:image/...;base64,....) inside
 * MongoDB, uploads each one to Cloudinary, and replaces it with the returned
 * secure_url. This fixes "save failed / network error" issues caused by
 * oversized PUT requests once too many base64 images have piled up.
 *
 * Run this LOCALLY (or from a Render shell) — not as part of the running server.
 *
 * Setup:
 *   1) Put this file in the same folder as your server.js / package.json
 *   2) Make sure your .env has MONGODB_URI + CLOUDINARY_* vars (same ones Render uses)
 *   3) Run:  node migrate-images-to-cloudinary.js
 *
 * It's safe to re-run — anything already a Cloudinary/http(s) URL is skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const BucketSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'main' },
  data: { type: mongoose.Schema.Types.Mixed, default: [] }
}, { timestamps: true, strict: false });

const BUCKETS = [
  { name: 'Products', model: mongoose.model('Products', BucketSchema, 'products') },
  { name: 'Categories', model: mongoose.model('Categories', BucketSchema, 'categories') },
  { name: 'Services', model: mongoose.model('Services', BucketSchema, 'services') },
];

// Which field(s) on each item hold the image. Adjust here if your data uses
// a different key (e.g. 'image' instead of 'img').
const IMAGE_FIELDS = ['img', 'image', 'icon']; // 'icon' only migrated if it looks like base64

function isBase64Image(val) {
  return typeof val === 'string' && val.startsWith('data:image/');
}

async function uploadOne(dataUrl, folder) {
  const result = await cloudinary.uploader.upload(dataUrl, {
    folder: folder || 'dhopa-mama',
    resource_type: 'image'
  });
  return result.secure_url;
}

async function migrateBucket(name, Model) {
  const doc = await Model.findOne({ key: 'main' });
  if (!doc || !Array.isArray(doc.data)) {
    console.log(`[${name}] no array data found, skipping.`);
    return;
  }

  let changed = 0;
  let failed = 0;

  for (const item of doc.data) {
    if (!item || typeof item !== 'object') continue;
    for (const field of IMAGE_FIELDS) {
      const val = item[field];
      if (isBase64Image(val)) {
        try {
          const approxKb = Math.round((val.length * 3) / 4 / 1024);
          console.log(`[${name}] uploading "${item.t || item.name || item._id || '?'}" field="${field}" (~${approxKb}KB)...`);
          const url = await uploadOne(val, 'dhopa-mama');
          item[field] = url;
          changed++;
        } catch (e) {
          console.error(`[${name}] FAILED to upload for item`, item.t || item.name || item._id, e.message);
          failed++;
        }
      }
    }
  }

  if (changed > 0) {
    doc.markModified('data');
    await doc.save();
    console.log(`[${name}] done. Migrated ${changed} image(s), ${failed} failure(s). Saved back to MongoDB.`);
  } else {
    console.log(`[${name}] no base64 images found. Nothing to do. (${failed} failure(s) attempting reads, if any)`);
  }
}

(async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected. Starting migration...\n');

  for (const b of BUCKETS) {
    await migrateBucket(b.name, b.model);
  }

  console.log('\nAll buckets processed. Disconnecting.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});