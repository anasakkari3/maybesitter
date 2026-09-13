// Same request handler as production; SQLite is exclusively for local preview.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleEarlyAccess, digest } from '../lib/earlyAccess/service.ts';

if (process.env.NODE_ENV === 'production' || process.env.K_SERVICE) throw new Error('Local preview only; use the Firestore-backed API in production.');
const root = fileURLToPath(new URL('../site/', import.meta.url));
const dataDir = fileURLToPath(new URL('../.maybesitter/early-access-preview/', import.meta.url));
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'registrations.sqlite'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS registrations (email TEXT PRIMARY KEY, name TEXT NOT NULL, device TEXT NOT NULL, phone TEXT, source TEXT NOT NULL, registeredAt TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resetsAt INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS metrics (key TEXT PRIMARY KEY, event TEXT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL)');
const store = {
  async register(r) { return db.prepare('INSERT OR IGNORE INTO registrations (email,name,device,phone,source,registeredAt) VALUES (?,?,?,?,?,?)').run(r.email,r.name,r.device,r.phone,r.source,r.registeredAt).changes > 0; },
  async allow(key, now, limit) {
    db.prepare('DELETE FROM rate_limits WHERE resetsAt <= ?').run(now);
    const row = db.prepare('SELECT count FROM rate_limits WHERE key=?').get(key);
    if (row && row.count >= limit) return false;
    db.prepare('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+3600000); return true;
  },
  async event(event,source,day) { db.prepare('INSERT INTO metrics VALUES (?,?,?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(digest(`${day}:${source}:${event}`),event,source,day); }
};
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.json':'application/json' };
const port = Number(process.env.PORT || 8788);
createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/early-access' || url.pathname === '/api/early-access/events') {
      let size=0; const chunks=[];
      for await (const chunk of req) { size+=chunk.length; if(size>4096){res.writeHead(413);res.end();return;} chunks.push(chunk); }
      const request = new Request(url, { method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{}) });
      const result = await handleEarlyAccess(request,()=>store);
      res.writeHead(result.status,Object.fromEntries(result.headers)); res.end(await result.text()); return;
    }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405);res.end();return; }
    let pathname=decodeURIComponent(url.pathname);
    if(pathname==='/' || pathname==='/en' || pathname==='/en/') pathname='/index.html';
    let file=path.resolve(root,`.${pathname}`);
    if (!file.startsWith(root) || pathname.split('/').some(p=>p.startsWith('.')) || !mime[path.extname(file)]) {res.writeHead(404);res.end();return;}
    await stat(file); const bytes=await readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});
    res.end(req.method==='HEAD'?undefined:bytes);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`MaybeSitter launch preview: http://127.0.0.1:${port}/`));
