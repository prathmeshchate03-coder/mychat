// JenChat Database Handler (Native MongoDB client)
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const MONGO_URI = process.env.MONGO_URI;

let db = null;
let client = null;

async function initDB() {
  if (db) return db;
  if (!MONGO_URI) {
    console.error("CRITICAL: MONGO_URI env variable missing!");
    process.exit(1);
  }
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('jenchat_db');
  
  // Create indexes for quick unique searches
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  console.log("MongoDB Dynamic Database Synced Successfully!");
  return db;
}

// Secure PBKDF2 Password hashing solution (No external bcrypt needed)
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

module.exports = { initDB, hashPassword };
