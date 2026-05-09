const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
// const Database = require('better-sqlite3');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// static uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

// Optional Supabase integration
const SUPABASE_ENABLED = !!process.env.SUPABASE_ENABLED;
let supabase = null;
let SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'uploads';
if(SUPABASE_ENABLED){
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase enabled but credentials missing');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// init db
const dbFile = path.join(__dirname, 'data.sqlite');
const db = new Database(dbFile);

// create tables
db.prepare(`CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  cat TEXT,
  badge TEXT,
  brand TEXT,
  name TEXT,
  desc TEXT,
  img TEXT,
  price REAL,
  priceOld REAL,
  rating REAL DEFAULT 0,
  reviews INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT,
  email TEXT,
  phone TEXT,
  subject TEXT,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 1_000_000 } }); // 1MB limit

// API
app.get('/api/products', (req, res) => {
  if(SUPABASE_ENABLED){
    supabase.from('products').select('*').order('created_at',{ ascending: false }).then(({ data, error })=>{
      if(error){ console.warn('supabase read failed', error); const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all(); return res.json(rows); }
      return res.json(data);
    }).catch(e=>{ console.warn(e); const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all(); return res.json(rows); });
    return;
  }
  const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/products', upload.single('image'), (req, res) => {
  const { cat, badge, brand, name, desc, price, priceOld } = req.body;
  let imgPath = null;
  if(req.file) imgPath = '/uploads/' + req.file.filename;

  // if supabase enabled, upload file and insert to supabase then mirror to sqlite
  if(SUPABASE_ENABLED){
    (async ()=>{
      try{
        let publicUrl = null;
        if(req.file){
          const dest = `uploads/${req.file.filename}`;
          const { data: upData, error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(dest, fs.createReadStream(path.join(UPLOAD_DIR, req.file.filename)), { upsert: false });
          if(upErr){ console.warn('supabase upload failed', upErr); }
          const { data: pu } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(dest);
          publicUrl = pu.publicUrl;
        }
        const ins = { cat, badge, brand, name, desc, img: publicUrl || imgPath, price: price||0, priceOld: priceOld||null };
        const { data, error } = await supabase.from('products').insert([ins]);
        if(error){ console.warn('supabase insert failed', error); return res.status(500).json({ error }); }
        // mirror into sqlite
        const row = data[0];
        const stmt = db.prepare('INSERT INTO products (id,cat,badge,brand,name,desc,img,price,priceOld,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        try{ stmt.run(row.id, row.cat, row.badge, row.brand, row.name, row.desc, row.img, row.price, row.priceOld, row.created_at); }catch(e){ console.warn('mirror insert sqlite failed',e); }
        return res.json(row);
      }catch(e){ console.error(e); return res.status(500).json({ error: String(e) }); }
    })();
    return;
  }

  const stmt = db.prepare('INSERT INTO products (cat,badge,brand,name,desc,img,price,priceOld) VALUES (?,?,?,?,?,?,?,?)');
  const info = stmt.run(cat, badge, brand, name, desc, imgPath, price || 0, priceOld || null);
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.json(prod);
});

// update product
app.put('/api/products/:id', upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const { cat, badge, brand, name, desc, price, priceOld } = req.body;
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if(!existing) return res.status(404).json({ error: 'not found' });
  // if supabase enabled, update there and mirror
  if(SUPABASE_ENABLED){
    (async ()=>{
      try{
        let publicUrl = existing.img;
        if(req.file){
          // delete old if in uploads
          if(existing.img && existing.img.startsWith('/uploads')){
            const oldPath = existing.img.replace(/^\//,'');
            try{ fs.unlinkSync(path.join(__dirname, oldPath)); }catch(e){}
          }
          const dest = `uploads/${req.file.filename}`;
          const { data: upData, error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(dest, fs.createReadStream(path.join(UPLOAD_DIR, req.file.filename)), { upsert: true });
          if(upErr) console.warn('supabase upload error', upErr);
          const { data: pu } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(dest);
          publicUrl = pu.publicUrl;
        }
        const upd = { cat: cat||existing.cat, badge: badge||existing.badge, brand: brand||existing.brand, name: name||existing.name, desc: desc||existing.desc, img: publicUrl, price: price||existing.price, priceOld: priceOld||existing.priceOld };
        const { data, error } = await supabase.from('products').update(upd).eq('id', id).select().single();
        if(error) return res.status(500).json({ error });
        // mirror to sqlite
        const stmt = db.prepare('UPDATE products SET cat = ?, badge = ?, brand = ?, name = ?, desc = ?, img = ?, price = ?, priceOld = ? WHERE id = ?');
        try{ stmt.run(data.cat, data.badge, data.brand, data.name, data.desc, data.img, data.price, data.priceOld, id); }catch(e){ console.warn('mirror sqlite update failed',e); }
        return res.json(data);
      }catch(e){ console.error(e); return res.status(500).json({ error: String(e) }); }
    })();
    return;
  }
  let imgPath = existing.img;
  if(req.file){
    if(existing.img){ const file = path.join(__dirname, existing.img.replace(/^\//,'')); if(fs.existsSync(file)) fs.unlinkSync(file); }
    imgPath = '/uploads/' + req.file.filename;
  }
  const stmt = db.prepare('UPDATE products SET cat = ?, badge = ?, brand = ?, name = ?, desc = ?, img = ?, price = ?, priceOld = ? WHERE id = ?');
  stmt.run(cat || existing.cat, badge || existing.badge, brand || existing.brand, name || existing.name, desc || existing.desc, imgPath, price || existing.price, priceOld || existing.priceOld, id);
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.json(prod);
});

app.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT img FROM products WHERE id = ?').get(id);
  if(SUPABASE_ENABLED){
    (async ()=>{
      try{
        // delete from supabase
        const { data, error } = await supabase.from('products').delete().eq('id', id);
        if(error) console.warn('supabase delete failed', error);
        // delete object if uploaded
        if(row && row.img && row.img.startsWith('/uploads')){
          const obj = row.img.replace(/^\//,'');
          try{ await supabase.storage.from(SUPABASE_BUCKET).remove([obj]); }catch(e){ console.warn('supabase remove object failed',e); }
        }
        // mirror delete to sqlite
        db.prepare('DELETE FROM products WHERE id = ?').run(id);
        return res.json({ ok:true });
      }catch(e){ console.error(e); return res.status(500).json({ error: String(e) }); }
    })();
    return;
  }
  if(row && row.img){
    const file = path.join(__dirname, row.img.replace(/^\//,''));
    if(fs.existsSync(file)) fs.unlinkSync(file);
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok:true });
});

// settings
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  rows.forEach(r => { try{ out[r.key]=JSON.parse(r.value); }catch(e){ out[r.key]=r.value; } });
  res.json(out);
});

app.post('/api/settings', upload.fields([{ name:'hero' }, { name:'about' }]), (req, res) => {
  const body = req.body || {};
  const files = req.files || {};
  const settings = {};
  if(body.hideHeroContent) settings.hideHeroContent = body.hideHeroContent === 'true';
  if(body.aboutText) settings.aboutText = body.aboutText;
  if(files.hero && files.hero[0]) settings.heroImg = '/uploads/' + files.hero[0].filename;
  if(files.about && files.about[0]) settings.aboutImg = '/uploads/' + files.about[0].filename;
  if(body.contact) {
    try{ settings.contact = JSON.parse(body.contact); }catch(e){}
  }
  // upsert
  const up = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  Object.keys(settings).forEach(k => up.run(k, JSON.stringify(settings[k])));
  res.json({ ok:true, settings });
});

// contacts
app.get('/api/contacts', (req,res) => { const rows = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all(); res.json(rows); });
app.post('/api/contacts', (req,res) => { const { name,email,phone,subject,message } = req.body; const stmt = db.prepare('INSERT INTO contacts (name,email,phone,subject,message) VALUES (?,?,?,?,?)'); const info = stmt.run(name,email,phone,subject,message); const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid); res.json(row); });
app.delete('/api/contacts/:id',(req,res)=>{ db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(req.params.id)); res.json({ ok:true }); });

// serve static site (optional) — serve your admin and site files
app.use('/', express.static(path.join(__dirname)));

app.listen(PORT, ()=>console.log('Server listening on',PORT));
