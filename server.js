const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// All persistent data (WhatsApp sessions AND customer lists) lives under this
// one root, which should be a Railway Volume mount so it survives redeploys.
// Structure:
//   DATA_ROOT/accounts.json          <- list of {id, label, createdAt}
//   DATA_ROOT/<accountId>/session/   <- that account's WhatsApp login session
//   DATA_ROOT/<accountId>/customers.json
const DATA_ROOT = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.data');
const ACCOUNTS_FILE = path.join(DATA_ROOT, 'accounts.json');

// Optional admin password. If ADMIN_PASSWORD is not set, the admin page and
// its API are completely open (as requested). Set the env var to require
// ?key=... on admin routes.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

function accountDir(id) {
  return path.join(DATA_ROOT, id);
}
function customersFile(id) {
  return path.join(accountDir(id), 'customers.json');
}

// runtime (in-memory) state per account: id -> { label, client, isReady, latestQr, statusMessage, sendLog, startingUp }
const runtime = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- One-time migration from the old single-account layout ----
//
// The previous version of this app stored the WhatsApp session directly at
// DATA_ROOT/session/... and the customer list at <project>/customers.json.
// If we detect that old layout and no accounts.json yet, fold it into a
// "default" account so existing logins/customers aren't lost.
function migrateLegacyDataIfNeeded() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  if (fs.existsSync(ACCOUNTS_FILE)) return;

  const legacySession = path.join(DATA_ROOT, 'session');
  const legacyCustomers = path.join(__dirname, 'customers.json');
  const hasLegacyData = fs.existsSync(legacySession) || fs.existsSync(legacyCustomers);

  if (!hasLegacyData) {
    // Fresh install, nothing to migrate — start with an empty account list.
    saveAccountsList([]);
    return;
  }

  console.log('Running one-time migration to multi-account data layout...');
  const defaultId = 'default';
  const defaultDir = accountDir(defaultId);
  fs.mkdirSync(defaultDir, { recursive: true });

  const newSessionPath = path.join(defaultDir, 'session');
  if (fs.existsSync(legacySession) && !fs.existsSync(newSessionPath)) {
    try {
      fs.renameSync(legacySession, newSessionPath);
      console.log('Migrated existing WhatsApp session into the "default" account.');
    } catch (err) {
      console.error('Could not migrate legacy session:', err.message);
    }
  }

  const newCustomersPath = customersFile(defaultId);
  if (fs.existsSync(legacyCustomers) && !fs.existsSync(newCustomersPath)) {
    try {
      fs.copyFileSync(legacyCustomers, newCustomersPath);
      console.log('Migrated existing customer list into the "default" account.');
    } catch (err) {
      console.error('Could not migrate legacy customers.json:', err.message);
    }
  }
  if (!fs.existsSync(newCustomersPath)) {
    fs.writeFileSync(newCustomersPath, '[]');
  }

  saveAccountsList([{ id: defaultId, label: 'Main Account', createdAt: new Date().toISOString() }]);
}

function loadAccountsList() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch (err) {
    return [];
  }
}
function saveAccountsList(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}

function getCustomers(id) {
  try {
    return JSON.parse(fs.readFileSync(customersFile(id), 'utf-8'));
  } catch (err) {
    return [];
  }
}
function saveCustomersFor(id, list) {
  fs.mkdirSync(accountDir(id), { recursive: true });
  fs.writeFileSync(customersFile(id), JSON.stringify(list, null, 2));
}

// ---- Crash-loop protection (same fix as before, now per-account folder) ----
//
// Chromium writes a "SingletonLock" file into its profile folder while
// running and removes it on clean exit. If the container is killed/crashes,
// that lock is left behind. Because profile folders live on a persistent
// volume, the next start sees the stale lock and refuses to launch Chromium,
// crashing again — a loop. Fix: wipe stale locks before every launch attempt,
// and never let a launch failure kill the whole Node process.
const LOCK_FILENAMES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);

function removeStaleLockFiles(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeStaleLockFiles(fullPath);
    } else if (LOCK_FILENAMES.has(entry.name)) {
      try {
        fs.unlinkSync(fullPath);
        console.log('Removed stale Chromium lock file:', fullPath);
      } catch (err) {
        console.error('Could not remove lock file:', fullPath, err.message);
      }
    }
  }
}

function initRuntime(id, label) {
  runtime.set(id, {
    label,
    client: null,
    isReady: false,
    latestQr: null,
    statusMessage: 'Starting up...',
    sendLog: [],
    startingUp: false
  });
}

function createClientFor(id) {
  const state = runtime.get(id);
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: accountDir(id) }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  c.on('qr', async (qr) => {
    state.latestQr = await qrcode.toDataURL(qr);
    state.isReady = false;
    state.statusMessage = 'Scan the QR code with WhatsApp (Linked Devices)';
    console.log(`[${id}] QR code generated.`);
  });

  c.on('ready', () => {
    state.isReady = true;
    state.latestQr = null;
    state.statusMessage = 'Connected. Ready to send messages.';
    console.log(`[${id}] WhatsApp client is ready.`);
  });

  c.on('disconnected', (reason) => {
    state.isReady = false;
    state.statusMessage = `Disconnected: ${reason}. Reconnecting...`;
    console.log(`[${id}] Client disconnected:`, reason);
    scheduleStart(id, 5000);
  });

  c.on('auth_failure', (msg) => {
    state.isReady = false;
    state.statusMessage = `Auth failure: ${msg}`;
    console.error(`[${id}] Auth failure:`, msg);
  });

  return c;
}

async function startAccountClient(id) {
  const state = runtime.get(id);
  if (!state || state.startingUp) return;
  state.startingUp = true;
  state.statusMessage = 'Starting WhatsApp client...';

  removeStaleLockFiles(accountDir(id));

  try {
    state.client = createClientFor(id);
    await state.client.initialize();
  } catch (err) {
    console.error(`[${id}] Failed to initialize WhatsApp client:`, err.message);
    state.statusMessage = 'Failed to start WhatsApp client, retrying shortly...';
    scheduleStart(id, 10000);
  } finally {
    state.startingUp = false;
  }
}

function scheduleStart(id, delayMs) {
  setTimeout(() => {
    if (runtime.has(id)) startAccountClient(id);
  }, delayMs);
}

function generateAccountId() {
  return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Catch anything that slips through so the process never hard-crashes.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (ignored to keep server alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored to keep server alive):', err);
});

async function shutdown() {
  console.log('Shutting down gracefully...');
  for (const [id, state] of runtime.entries()) {
    try {
      if (state.client) await state.client.destroy();
    } catch (err) {
      console.error(`[${id}] Error during shutdown:`, err.message);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---- Boot ----
migrateLegacyDataIfNeeded();
for (const acc of loadAccountsList()) {
  initRuntime(acc.id, acc.label);
  startAccountClient(acc.id);
}

// ---- Admin auth (optional, off by default) ----
function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const provided = req.query.key || req.headers['x-admin-key'];
  if (provided === ADMIN_PASSWORD) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_PASSWORD to the URL, or set the x-admin-key header.');
}

// ---- Pages ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/account/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Admin API ----
app.get('/api/admin/accounts', requireAdminAuth, (req, res) => {
  const list = loadAccountsList();
  const withStatus = list.map((a) => {
    const state = runtime.get(a.id) || {};
    return {
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
      isReady: !!state.isReady,
      statusMessage: state.statusMessage || 'Unknown',
      customerCount: getCustomers(a.id).length
    };
  });
  res.json(withStatus);
});

app.post('/api/admin/accounts', requireAdminAuth, (req, res) => {
  const label = (req.body.label || '').trim() || 'New Account';
  const id = generateAccountId();
  const list = loadAccountsList();
  list.push({ id, label, createdAt: new Date().toISOString() });
  saveAccountsList(list);
  initRuntime(id, label);
  saveCustomersFor(id, []);
  startAccountClient(id);
  res.json({ ok: true, id, label });
});

app.delete('/api/admin/accounts/:id', requireAdminAuth, async (req, res) => {
  const id = req.params.id;
  const list = loadAccountsList();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Account not found.' });

  const state = runtime.get(id);
  if (state && state.client) {
    try {
      await state.client.destroy();
    } catch (err) {
      console.error(`[${id}] Error destroying client:`, err.message);
    }
  }
  runtime.delete(id);
  list.splice(idx, 1);
  saveAccountsList(list);

  try {
    fs.rmSync(accountDir(id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[${id}] Error removing account data:`, err.message);
  }

  res.json({ ok: true });
});

// ---- Per-account API (used by the /account/:id page) ----
function requireAccount(req, res, next) {
  if (!runtime.has(req.params.id)) return res.status(404).json({ error: 'Account not found.' });
  next();
}

app.get('/api/accounts/:id/status', requireAccount, (req, res) => {
  const s = runtime.get(req.params.id);
  res.json({ isReady: s.isReady, statusMessage: s.statusMessage, hasQr: !!s.latestQr, label: s.label });
});

app.get('/api/accounts/:id/qr', requireAccount, (req, res) => {
  const s = runtime.get(req.params.id);
  res.json({ qr: s.latestQr || null });
});

app.get('/api/accounts/:id/customers', requireAccount, (req, res) => {
  res.json(getCustomers(req.params.id));
});

app.post('/api/accounts/:id/customers', requireAccount, (req, res) => {
  const list = req.body.customers;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'customers must be an array' });

  for (const entry of list) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      return res.status(400).json({ error: 'Every contact needs a name.' });
    }
    const digits = String(entry.number || '').replace(/\D/g, '');
    if (digits.length < 8) {
      return res.status(400).json({ error: `Invalid number for ${entry.name}.` });
    }
    entry.number = digits;
  }

  saveCustomersFor(req.params.id, list);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/log', requireAccount, (req, res) => {
  res.json(runtime.get(req.params.id).sendLog);
});

// Send the same message to every customer of this account, one at a time,
// with a random delay between each send.
app.post('/api/accounts/:id/send', requireAccount, async (req, res) => {
  const id = req.params.id;
  const state = runtime.get(id);
  const { message } = req.body;

  if (!state.isReady || !state.client) return res.status(400).json({ error: 'WhatsApp is not connected yet. Scan the QR code first.' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

  const customers = getCustomers(id);
  if (customers.length === 0) return res.status(400).json({ error: 'No customers configured.' });

  res.json({ ok: true, queued: customers.length });

  state.sendLog = [];
  for (const customer of customers) {
    const number = String(customer.number).replace(/\D/g, '');
    const chatId = `${number}@c.us`;
    try {
      const personalized = message.replace(/\{name\}/g, customer.name || '');
      await state.client.sendMessage(chatId, personalized);
      state.sendLog.push({ name: customer.name, number, status: 'sent', time: new Date().toISOString() });
      console.log(`[${id}] Sent to ${customer.name} (${number})`);
    } catch (err) {
      state.sendLog.push({ name: customer.name, number, status: 'failed', error: err.message, time: new Date().toISOString() });
      console.error(`[${id}] Failed to send to ${customer.name} (${number}):`, err.message);
    }
    const delay = 4000 + Math.floor(Math.random() * 6000);
    await sleep(delay);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
