#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

async function main(){
  const argv = yargs(hideBin(process.argv)).option('config',{type:'string',default:'./supabase.config.json'}).option('run',{type:'boolean',default:false}).option('dry-run',{type:'boolean',default:false}).argv;
  const cfgPath = path.resolve(argv.config);
  if(!fs.existsSync(cfgPath)){
    console.error('Config not found at',cfgPath); process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath,'utf8'));
  const DRY = argv['dry-run'] || !argv.run;
  const SUPABASE_URL = cfg.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = cfg.SUPABASE_SERVICE_ROLE_KEY;
  const BUCKET = cfg.BUCKET || 'uploads';
  const SOURCE_UPLOADS_DIR = cfg.SOURCE_UPLOADS_DIR || './uploads';
  const SQLITE_FILE = cfg.SQLITE_FILE || './data.sqlite';

  let supabase = null;
  if(!DRY){
    if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY){ console.error('Supabase credentials missing in config'); process.exit(1); }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }

  // backups
  const backupDir = path.join(process.cwd(),'migration-backups');
  if(!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  const now = new Date().toISOString().replace(/[:.]/g,'-');
  const sqliteBackup = path.join(backupDir, `data.sqlite.${now}.bak`);
  fs.copyFileSync(SQLITE_FILE, sqliteBackup);
  console.log('Backed up sqlite to',sqliteBackup);

  // copy uploads list (not copying files by default)
  const uploadsBackup = path.join(backupDir, `uploads-list.${now}.json`);
  const files = fs.existsSync(SOURCE_UPLOADS_DIR) ? fs.readdirSync(SOURCE_UPLOADS_DIR) : [];
  fs.writeFileSync(uploadsBackup, JSON.stringify(files, null, 2));
  console.log('Wrote uploads file list to', uploadsBackup);

  const db = new Database(SQLITE_FILE, { readonly: true });
  const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
  console.log(`Found ${rows.length} products in SQLite`);

  const plan = rows.map(r => ({ id: r.id, name: r.name, img: r.img, srcFile: r.img ? path.join(process.cwd(), r.img.replace(/^\//,'')) : null }));
  const planPath = path.join(process.cwd(),'migration-plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log('Wrote migration plan to', planPath);

  if(DRY){ console.log('Dry run complete. Use --run to perform migration.'); process.exit(0); }

  // perform migration
  const log = [];
  for(const r of rows){
    const item = { id: r.id, name: r.name, img: r.img, uploaded: false, uploadedPath: null, inserted: false, error: null };
    try{
      let uploadedPath = null;
      if(r.img){
        const src = path.join(process.cwd(), r.img.replace(/^\//,''));
        if(fs.existsSync(src)){
          const dest = `uploads/${path.basename(src)}`;
          const file = fs.readFileSync(src);
          const { data, error: upErr } = await supabase.storage.from(BUCKET).upload(dest, file, { upsert: false });
          if(upErr){
            // name collision? try with timestamp
            const dest2 = `uploads/${Date.now()}-${path.basename(src)}`;
            const { data: data2, error: upErr2 } = await supabase.storage.from(BUCKET).upload(dest2, file, { upsert: false });
            if(upErr2) throw upErr2; uploadedPath = dest2;
          } else { uploadedPath = dest; }
          item.uploaded = true; item.uploadedPath = uploadedPath;
        } else { item.error = `source file missing: ${src}`; console.warn(item.error); }
      }

      // compute img url to store
      let imgUrl = null;
      if(item.uploadedPath){
        // make public URL
        const { publicURL } = supabase.storage.from(BUCKET).getPublicUrl(item.uploadedPath);
        imgUrl = publicURL || null;
      } else if(r.img && r.img.startsWith('/uploads')){
        imgUrl = null; // no upload performed
      }

      const insertRow = {
        id: r.id,
        cat: r.cat,
        badge: r.badge,
        brand: r.brand,
        name: r.name,
        desc: r.desc,
        img: imgUrl || r.img,
        price: r.price,
        priceOld: r.priceOld,
        rating: r.rating,
        reviews: r.reviews,
        created_at: r.created_at
      };

      const { data: ins, error: insErr } = await supabase.from('products').insert([insertRow]);
      if(insErr){ throw insErr; }
      item.inserted = true;
    }catch(err){ item.error = String(err); console.error('Error migrating id', r.id, err); }
    log.push(item);
    fs.writeFileSync('migration-log.json', JSON.stringify(log, null, 2));
  }

  console.log('Migration complete. Wrote migration-log.json');
  console.log('IMPORTANT: after migration, run SQL to set sequence: SELECT setval(pg_get_serial_sequence(\'products\',\'id\'), (SELECT MAX(id) FROM products));');
  process.exit(0);
}

main().catch(e=>{ console.error(e); process.exit(1); });
