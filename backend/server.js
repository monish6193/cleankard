const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function readLocalSupabaseConfig() {
  const configPath = path.join(__dirname, 'supabase.config.json');
  if (!fs.existsSync(configPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn('Could not read supabase.config.json:', error.message);
    return {};
  }
}

const localConfig = readLocalSupabaseConfig();
const SUPABASE_URL = process.env.SUPABASE_URL || localConfig.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || localConfig.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || localConfig.BUCKET || 'uploads';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Supabase credentials missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 5_000_000 }
});

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function uploadFile(file) {
  if (!file) return null;

  const localPath = path.join(UPLOAD_DIR, file.filename);
  const storagePath = `uploads/${file.filename}`;
  try {
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, fs.createReadStream(localPath), {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) throw error;

    const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  } finally {
    fs.promises.unlink(localPath).catch(() => {});
  }
}

function getStoragePathFromPublicUrl(url) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) return null;
  return decodeURIComponent(url.slice(markerIndex + marker.length));
}

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.post('/api/products', upload.single('image'), async (req, res) => {
  try {
    const { cat, badge, brand, name, desc, price, priceOld } = req.body;
    const img = await uploadFile(req.file);
    const product = {
      cat,
      badge: badge || null,
      brand,
      name,
      desc,
      img,
      price: toNumber(price, 0),
      priceOld: toNumber(priceOld)
    };

    const { data, error } = await supabase
      .from('products')
      .insert([product])
      .select()
      .single();

    if (error) return res.status(500).json({ error });
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.put('/api/products/:id', upload.single('image'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data: existing, error: fetchError } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existing) return res.status(404).json({ error: 'not found' });

    const { cat, badge, brand, name, desc, price, priceOld } = req.body;
    let img = existing.img;

    if (req.file) {
      img = await uploadFile(req.file);
      const oldPath = getStoragePathFromPublicUrl(existing.img);
      if (oldPath) await supabase.storage.from(SUPABASE_BUCKET).remove([oldPath]);
    }

    const updates = {
      cat: cat || existing.cat,
      badge: badge || existing.badge,
      brand: brand || existing.brand,
      name: name || existing.name,
      desc: desc || existing.desc,
      img,
      price: toNumber(price, existing.price),
      priceOld: toNumber(priceOld, existing.priceOld)
    };

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error });
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data: existing } = await supabase
      .from('products')
      .select('img')
      .eq('id', id)
      .single();

    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) return res.status(500).json({ error });

    const oldPath = getStoragePathFromPublicUrl(existing && existing.img);
    if (oldPath) await supabase.storage.from(SUPABASE_BUCKET).remove([oldPath]);

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('key,value');
  if (error) return res.status(500).json({ error });

  const settings = {};
  (data || []).forEach((row) => {
    settings[row.key] = row.value;
  });

  res.json(settings);
});

app.post('/api/settings', upload.fields([{ name: 'hero' }, { name: 'about' }]), async (req, res) => {
  try {
    const body = req.body || {};
    const files = req.files || {};
    const settings = {};

    if (body.hideHeroContent !== undefined) settings.hideHeroContent = body.hideHeroContent === 'true';
    if (body.aboutTitle !== undefined) settings.aboutTitle = body.aboutTitle;
    if (body.aboutText !== undefined) settings.aboutText = body.aboutText;
    if (body.aboutText2 !== undefined) settings.aboutText2 = body.aboutText2;
    if (body.aboutMission !== undefined) settings.aboutMission = body.aboutMission;
    if (files.hero && files.hero[0]) settings.heroImg = await uploadFile(files.hero[0]);
    if (files.about && files.about[0]) settings.aboutImg = await uploadFile(files.about[0]);
    if (body.contact) settings.contact = JSON.parse(body.contact);

    const rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
    if (rows.length) {
      const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' });
      if (error) return res.status(500).json({ error });
    }

    res.json({ ok: true, settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/contacts', async (req, res) => {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.post('/api/contacts', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  const { data, error } = await supabase
    .from('contacts')
    .insert([{ name, email, phone, subject, message }])
    .select()
    .single();

  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete('/api/contacts/:id', async (req, res) => {
  const { error } = await supabase.from('contacts').delete().eq('id', Number(req.params.id));
  if (error) return res.status(500).json({ error });
  res.json({ ok: true });
});

app.use('/', express.static(path.join(__dirname, '..')));

app.listen(PORT, () => console.log('Server listening on', PORT));
