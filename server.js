// server-full.js — Kalé Control OS API v3 with Agent System
// Deploy to Replit: paste this as server.js
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const cron     = require('node-cron');
const { Resend } = require('resend');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_KEY    = process.env.RESEND_API_KEY    || '';
const ALERT_EMAIL   = process.env.ALERT_EMAIL       || '';
const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use((req, res, next) => {
res.header('Access-Control-Allow-Origin', '*');
res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
res.header('Access-Control-Allow-Headers', '*');
next();
});
app.options('*', (req, res) => res.sendStatus(200));
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });

// ─── Health ───────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
ok: true, ts: new Date().toISOString(), version: '3.0',
agents: Object.keys(AGENTS).length,
skills: {
ai_proxy:      !!ANTHROPIC_KEY,
web_search:    !!ANTHROPIC_KEY,
weather:       true,
notifications: !!(RESEND_KEY && ALERT_EMAIL),
agents:        !!ANTHROPIC_KEY,
}
}));

// ─── CLAUDE HELPER ────────────────────────────────────────────────
async function callClaude({ messages, system, tools, max_tokens = 1000 }) {
if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
const body = { model: 'claude-sonnet-4-20250514', max_tokens, messages };
if (system) body.system = system;
if (tools)  body.tools  = tools;
const r = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'x-api-key': ANTHROPIC_KEY,
'anthropic-version': '2023-06-01',
},
body: JSON.stringify(body),
});
const data = await r.json();
if (data.error) throw new Error(`[${data.error.type}] ${data.error.message}`);
return data;
}

function extractText(data) {
return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ─── DATA CONTEXT ─────────────────────────────────────────────────
function buildDataContext() {
try {
const today  = new Date().toISOString().slice(0,10);
const month  = today.slice(0,7);
const ings   = db.listAll('ings');
const recs   = db.listAll('recs');
const sales  = db.listAll('sales');
const waste  = db.listAll('waste');
const invs   = db.listAll('invs');
const staff  = db.listAll('staff');
const params = db.getParams();
const mRev   = sales.filter(s=>(s.date||'').startsWith(month)).reduce((t,s)=>t+(+s.amount||0),0);
const mCOGS  = invs.filter(i=>(i.date||'').startsWith(month)).reduce((t,i)=>t+(+i.net||0),0);
const mLab   = sales.filter(s=>(s.date||'').startsWith(month)).reduce((t,s)=>t+(+s.labor||0),0);
const mWaste = waste.filter(w=>(w.date||'').startsWith(month)).reduce((t,w)=>t+(+w.cost||0),0);
const ebitda = mRev - mCOGS - mLab;
const reorder= ings.filter(i=>i.reorderQty&&(+i.qty||0)<=(+i.reorderQty||0)).map(i=>i.name);
return `KALÉ RESTAURANT DATA (${today}): Τοποθεσία: Ιεράπετρα, Κρήτη Μηνιαίος τζίρος: €${mRev.toFixed(0)} | COGS: €${mCOGS.toFixed(0)} (${mRev>0?(mCOGS/mRev*100).toFixed(1):0}%) | Εργατικά: €${mLab.toFixed(0)} | EBITDA: €${ebitda.toFixed(0)} Σπατάλες μήνα: €${mWaste.toFixed(0)} | Υλικά: ${ings.length} | Συνταγές: ${recs.length} | Προσωπικό: ${staff.length} Reorder alert (${reorder.length}): ${reorder.slice(0,6).join(', ')||'none'} Στόχοι GP: Φαγητό ${params.FoodGP||70}% | Cocktail ${params.CocktailGP||80}% | Κρασί ${params.WineGP||75}%`;
} catch(e) { return 'RESTAURANT DATA: Not yet synced.'; }
}

// ─── AGENT DEFINITIONS ────────────────────────────────────────────
const AGENTS = {
chef: {
name:'Chef Agent', nameEL:'Σεφ Agent', emoji:'👨‍🍳', color:'#C27C20',
desc: 'Συνταγές, GP%, Menu Engineering, Σπατάλες',
descEN: 'Recipes, GP%, Menu Engineering, Waste',
system:`You are Chef Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: recipe costing, GP% optimization, menu engineering (Stars/Plowhorses/Puzzles/Dogs), ingredient waste, seasonal Cretan cuisine. Flag food cost >35% as critical. Target GP >70%. Answer in user's language (Greek/English). Be direct and practical.`,
schedule:'0 7 * * 1',
task:'Analyze recipes and ingredients. Identify: top 3 lowest GP% recipes, items near reorder, one menu improvement. Return HTML.',
alertSubject:'👨‍🍳 Chef Agent — Εβδομαδιαία Ανάλυση Μενού',
},
cfo: {
name:'CFO Agent', nameEL:'CFO Agent', emoji:'💰', color:'#2E7D52',
desc: 'EBITDA, Prime Cost, Cash Flow, Αποτίμηση, ΕΣΠΑ',
descEN: 'EBITDA, Prime Cost, Cash Flow, Valuation, ΕΣΠΑ',
system:`You are CFO Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: restaurant P&L, EBITDA, prime cost, cash flow, business valuation (3x-5x), Greek tax (ΦΠΑ 13%/24%), ΕΣΠΑ funding. Always show % of revenue alongside absolute numbers. Answer in user's language.`,
schedule:'0 8 1 * *',
task:'Monthly P&L: Revenue, COGS%, Labor%, EBITDA, Prime Cost status (Elite/Healthy/At Risk). Flag issues. Return HTML.',
alertSubject:'💰 CFO Agent — Μηνιαία Οικονομική Ανάλυση',
},
procurement: {
name:'Procurement Agent', nameEL:'Προμήθειες Agent', emoji:'📦', color:'#1A5276',
desc: 'Τιμολόγια, Προμηθευτές, Reorder, Τιμές Αγοράς',
descEN: 'Invoices, Suppliers, Reorder, Market Prices',
system:`You are Procurement Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: supplier management, invoice analysis, price tracking, reorder optimization, Greek/Cretan wholesale suppliers. Focus on cost savings. Answer in user's language.`,
schedule:'0 9 * * 3',
task:'Check inventory & invoices. Items needing reorder, price changes >5%, supplier performance. Return HTML with reorder list.',
alertSubject:'📦 Procurement — Έλεγχος Αποθέματος',
},
hr: {
name:'HR Agent', nameEL:'HR Agent', emoji:'👥', color:'#6B3F1F',
desc: 'Βάρδιες, Μισθοδοσία, ΕΦΚΑ, ΨΚΕ, Εργατικό Δίκαιο',
descEN: 'Shifts, Payroll, ΕΦΚΑ, ΨΚΕ, Labor Law',
system:`You are HR Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: Greek labor law, ΕΡΓΑΝΗ, ΕΦΚΑ (employee 13.87%, employer 21.79%), shift scheduling, payroll, ΨΚΕ compliance. Answer in user's language. Be precise with numbers.`,
schedule:'0 8 25 * *',
task:'Monthly payroll: gross/net wages, ΕΦΚΑ per employee, compliance issues. Return HTML.',
alertSubject:'👥 HR Agent — Μισθοδοσία Μήνα',
},
revenue: {
name:'Revenue Agent', nameEL:'Revenue Agent', emoji:'📈', color:'#5B6BF0',
desc: 'Τζίρος, Πρόβλεψη, Avg Check, RevPASH, Εποχικότητα',
descEN: 'Revenue, Forecast, Avg Check, RevPASH, Seasonality',
system:`You are Revenue Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: revenue forecasting, DOW patterns, Greek holiday impact, avg check optimization, table turns, RevPASH, Ierapetra tourism seasonality (peak Jun-Sep). Answer in user's language.`,
schedule:'0 21 * * *',
task:'Daily revenue analysis. Compare vs last month/year. Forecast tomorrow. Flag if below target. Return HTML.',
alertSubject:'📈 Revenue Agent — Ανάλυση Τζίρου',
},
ops: {
name:'Ops Agent', nameEL:'Λειτουργίες Agent', emoji:'⚙️', color:'#B33A2A',
desc: 'Σπατάλες, HACCP, Ενέργεια, Tasks, Συντήρηση',
descEN: 'Waste, HACCP, Energy, Tasks, Maintenance',
system:`You are Operations Agent for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete. Expert in: waste reduction, HACCP compliance, energy efficiency, task management, staff efficiency, Greek health & safety regulations. Answer in user's language. Focus on operational improvements.`,
schedule:'0 17 * * 5',
task:'Weekly ops review: waste trends, task completion, maintenance issues. Top 3 improvements. Return HTML.',
alertSubject:'⚙️ Ops Agent — Εβδομαδιαία Επιθεώρηση',
},
};

// Agent conversation memory (per session)
const agentMemory = {};
Object.keys(AGENTS).forEach(k => { agentMemory[k] = []; });

// ─── AI PROXY ─────────────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
try {
const { messages, system, max_tokens=1000, use_web_search=false } = req.body;
if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
const fullSystem = ['You are an expert restaurant consultant for Kalé, Mediterranean Gastro-Bar, Ierapetra, Crete.',
'Answer in the same language as the user (Greek or English). Be concise and actionable.',
buildDataContext(), system||''].filter(Boolean).join('\n\n');
const tools = use_web_search ? [{type:'web_search_20250305',name:'web_search'}] : undefined;
const data = await callClaude({ messages, system: fullSystem, tools, max_tokens });
res.json(data);
} catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── AGENT ROUTES ─────────────────────────────────────────────────
app.get('/api/agents', (_req, res) => {
res.json({ ok:true, agents: Object.entries(AGENTS).map(([id,a])=>({
id, name:a.name, nameEL:a.nameEL, emoji:a.emoji, color:a.color,
desc:a.desc, descEN:a.descEN,
schedule:a.schedule,
memoryLength:(agentMemory[id]||[]).length,
}))});
});

app.post('/api/agent/:name/chat', async (req, res) => {
const agent = AGENTS[req.params.name];
if (!agent) return res.status(404).json({ error: 'Agent not found' });
const { message } = req.body;
if (!message) return res.status(400).json({ error: 'message required' });
try {
agentMemory[req.params.name].push({ role:'user', content:message });
if (agentMemory[req.params.name].length > 20)
agentMemory[req.params.name] = agentMemory[req.params.name].slice(-20);
const data = await callClaude({
messages: agentMemory[req.params.name],
system: agent.system + '\n\n' + buildDataContext(),
max_tokens: 1200,
});
const reply = extractText(data);
agentMemory[req.params.name].push({ role:'assistant', content:reply });
res.json({ ok:true, reply, agent:req.params.name, emoji:agent.emoji, color:agent.color });
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/:name/run', async (req, res) => {
const agent = AGENTS[req.params.name];
if (!agent) return res.status(404).json({ error: 'Agent not found' });
try {
const data = await callClaude({
messages:[{ role:'user', content:agent.task }],
system: agent.system + '\n\n' + buildDataContext(),
max_tokens: 1000,
});
const html = extractText(data);
const sent = await sendAlert(agent.alertSubject, html);
res.json({ ok:true, html, emailSent:sent });
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agent/:name/memory', (req, res) => {
if (!AGENTS[req.params.name]) return res.status(404).json({ error:'Agent not found' });
agentMemory[req.params.name] = [];
res.json({ ok:true });
});

// ─── WEATHER ──────────────────────────────────────────────────────
app.get('/api/weather', async (_req, res) => {
try {
const url = 'https://api.open-meteo.com/v1/forecast?latitude=35.0047&longitude=25.7440&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FAthens&forecast_days=14&timeformat=iso8601';
const r = await fetch(url);
const d = await r.json();
if (!d.daily) return res.status(502).json({ error:'No weather data' });
res.json({ ok:true, location:'Ierapetra', days: d.daily.time.map((dt,i)=>({
date:dt, wmo:d.daily.weathercode[i]||0,
tmax:d.daily.temperature_2m_max[i]||0,
tmin:d.daily.temperature_2m_min[i]||0,
rain:d.daily.precipitation_sum[i]||0,
}))});
} catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SEARCH ───────────────────────────────────────────────────────
app.post('/api/search/espa', async (_req, res) => {
try {
const data = await callClaude({
messages:[{role:'user',content:'Search latest ΕΣΠΑ 2021-2027 funding for Greek restaurants 2025-2026. Include EU funds, tax breaks, employment programs.'}],
system:'Return JSON array max 8 items: [{title,summary,url,date,category,amount}]. No markdown.',
tools:[{type:'web_search_20250305',name:'web_search'}], max_tokens:1000,
});
const txt = extractText(data);
try { const js=txt.indexOf('['),je=txt.lastIndexOf(']'); res.json({ok:true,results:JSON.parse(txt.slice(js,je+1))}); }
catch { res.json({ok:true,results:[],raw:txt}); }
} catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/search/prices', async (req, res) => {
try {
const { product } = req.body;
if (!product) return res.status(400).json({error:'product required'});
const data = await callClaude({
messages:[{role:'user',content:`Search current wholesale/retail prices for "${product}" in Greece. Check Sklavenitis, AB, Lidl, Metro Cash & Carry.`}],
system:'Return JSON: {product,unit,results:[{source,price_per_unit,unit,notes}],cheapest:{source,price_per_unit},recommendation}. No markdown.',
tools:[{type:'web_search_20250305',name:'web_search'}], max_tokens:1000,
});
const txt = extractText(data);
try { const js=txt.indexOf('{'),je=txt.lastIndexOf('}'); res.json({ok:true,data:JSON.parse(txt.slice(js,je+1))}); }
catch { res.json({ok:true,data:null,raw:txt}); }
} catch(e) { res.status(500).json({error:e.message}); }
});

// ─── NOTIFICATIONS ────────────────────────────────────────────────
async function sendAlert(subject, htmlBody) {
if (!resend || !ALERT_EMAIL) { console.log('[Notify skipped]'); return false; }
try {
await resend.emails.send({
from: 'Kale OS <alerts@kale-os.com>',
to: ALERT_EMAIL, subject, html: htmlBody,
});
return true;
} catch(e) { console.error('[Notify error]', e.message); return false; }
}

app.post('/api/notify/test', async (_req, res) => {
const ok = await sendAlert('✅ Kalé OS Test', `<h2>Η σύνδεση email λειτουργεί!</h2><p>Email: ${ALERT_EMAIL}</p>`);
res.json({ ok, email: ALERT_EMAIL });
});

// ─── PARAMS (must be before /:collection wildcard) ────────────────
app.get('/api/params',  (_req,res) => { try{res.json(db.getParams());}catch(e){res.status(500).json({error:e.message});} });
app.put('/api/params',  (req,res)  => { try{res.json(db.setParams(req.body));}catch(e){res.status(500).json({error:e.message});} });

// ─── CRUD ─────────────────────────────────────────────────────────
const VALID = new Set(db.COLLECTIONS);
app.param('collection', (req,res,next,col) => { if(!VALID.has(col)) return res.status(404).json({error:`Unknown: ${col}`}); req.col=col; next(); });
app.get   ('/api/:collection',      (req,res) => { try{res.json(db.listAll(req.col));}catch(e){res.status(500).json({error:e.message});} });
app.post  ('/api/:collection',      (req,res) => { try{const id=req.body.id||`${Date.now()}_${Math.random().toString(36).slice(2,7)}`;res.status(201).json(db.upsert(req.col,id,req.body));}catch(e){res.status(500).json({error:e.message});} });
app.put   ('/api/:collection/bulk', (req,res) => { try{if(!Array.isArray(req.body))return res.status(400).json({error:'Array expected'});res.json(db.bulkReplace(req.col,req.body));}catch(e){res.status(500).json({error:e.message});} });
app.put   ('/api/:collection/:id',  (req,res) => { try{res.json(db.upsert(req.col,req.params.id,req.body));}catch(e){res.status(500).json({error:e.message});} });
app.delete('/api/:collection/:id',  (req,res) => { try{db.remove(req.col,req.params.id)?res.json({ok:true}):res.status(404).json({error:'Not found'});}catch(e){res.status(500).json({error:e.message});} });

// ─── CRON JOBS ────────────────────────────────────────────────────
// Daily briefing 08:00
cron.schedule('0 8 * * *', async () => {
try {
const data = await callClaude({ messages:[{role:'user',content:'Generate daily briefing: top 3 priorities, reorder alerts, GP issues, one tip. HTML format.'}], system:buildDataContext(), max_tokens:800 });
await sendAlert(`☕ Kalé Daily Briefing — ${new Date().toLocaleDateString('el-GR')}`, extractText(data));
} catch(e) { console.error('[CRON briefing]', e.message); }
}, { timezone:'Europe/Athens' });

// Per-agent scheduled tasks
Object.entries(AGENTS).forEach(([name, agent]) => {
cron.schedule(agent.schedule, async () => {
console.log(`[CRON] ${agent.name}`);
try {
const data = await callClaude({ messages:[{role:'user',content:agent.task}], system:agent.system+'\n\n'+buildDataContext(), max_tokens:1000 });
await sendAlert(agent.alertSubject, extractText(data));
} catch(e) { console.error(`[CRON ${name}]`, e.message); }
}, { timezone:'Europe/Athens' });
});

// ─── START ────────────────────────────────────────────────────────
app.use((_req,res) => res.status(404).json({error:'Not found'}));
app.use((err,_req,res,_next) => res.status(500).json({error:err.message}));

app.listen(PORT, () => {
console.log(`\n✅  Kalé Control OS API v3 — Agent System`);
console.log(`    http://localhost:${PORT}/api/health`);
console.log(`\n    Agents (${Object.keys(AGENTS).length}):`);
Object.entries(AGENTS).forEach(([id,a]) => console.log(`    ${a.emoji}  ${a.name} [${id}]`));
console.log(`\n    Services:`);
console.log(`    🤖 AI + Agents  → ${ANTHROPIC_KEY?'✅':'❌ ANTHROPIC_API_KEY missing'}`);
console.log(`    🌤 Weather      → ✅ Open-Meteo (Ierapetra)`);
console.log(`    📧 Email alerts → ${(RESEND_KEY&&ALERT_EMAIL)?'✅ '+ALERT_EMAIL:'❌ RESEND_API_KEY / ALERT_EMAIL missing'}`);

// ─── SELF-PING every 5 min to prevent sleep ───────────────────────
setInterval(() => {
fetch(`http://localhost:${PORT}/api/health`)
.then(() => console.log(`[ping] ${new Date().toISOString()}`))
.catch(e => console.error('[ping error]', e.message));
}, 5 * 60 * 1000);
});

module.exports = app;
