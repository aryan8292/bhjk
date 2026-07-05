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

// ---- Bulk upload + auto-allocation pool ----
//
// Uploaded JSON/CSV contacts land in one shared pool, then get spread across
// existing accounts automatically (8-12 per account, no account exceeding 12
// total), so each number only handles a small, low-risk batch at a time.
const POOL_FILE = path.join(DATA_ROOT, 'pool.json');

function getPool() {
  try {
    return JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
  } catch (err) {
    return [];
  }
}
function savePool(list) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(list, null, 2));
}

// A bare 10-digit number (no country code) is assumed to be an Indian
// mobile number, so we prepend "91" automatically. Numbers that already
// include a country code (11+ digits) are left as-is.
function applyIndianCountryCode(digits) {
  if (digits.length === 10) return '91' + digits;
  return digits;
}

function normalizeContact(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name || entry.Name || entry.NAME || '').trim();
  const rawNumber = entry.number || entry.Number || entry.NUMBER || entry.phone || entry.Phone || entry.mobile || entry.Mobile || '';
  const number = applyIndianCountryCode(String(rawNumber).replace(/\D/g, ''));
  if (!name || number.length < 8) return null;
  return { name, number };
}

function getAllExistingNumbers() {
  const set = new Set();
  for (const acc of loadAccountsList()) {
    for (const c of getCustomers(acc.id)) set.add(c.number);
  }
  for (const c of getPool()) set.add(c.number);
  return set;
}

// Pure function (no file I/O) so it can be unit tested directly: spreads
// `pool` round-robin across `accountIds`, each account getting a random
// 8-12 sized chunk per round, never exceeding `capPerAccount` total.
function allocatePoolAcrossAccounts(pool, accountIds, existingCustomersByAccount, minChunk = 8, maxChunk = 12, capPerAccount = 12) {
  const poolCopy = pool.slice();
  const result = {};
  for (const id of accountIds) {
    result[id] = existingCustomersByAccount[id] ? existingCustomersByAccount[id].slice() : [];
  }

  let progress = true;
  while (poolCopy.length > 0 && progress && accountIds.length > 0) {
    progress = false;
    for (const id of accountIds) {
      if (poolCopy.length === 0) break;
      const current = result[id];
      const room = capPerAccount - current.length;
      if (room <= 0) continue;
      const desired = minChunk + Math.floor(Math.random() * (maxChunk - minChunk + 1));
      const chunkSize = Math.min(room, desired, poolCopy.length);
      if (chunkSize <= 0) continue;
      const existingNumbers = new Set(current.map((c) => c.number));
      let taken = 0;
      while (taken < chunkSize && poolCopy.length > 0) {
        const next = poolCopy.shift();
        if (!existingNumbers.has(next.number)) {
          current.push(next);
          existingNumbers.add(next.number);
        }
        taken++;
      }
      progress = true;
    }
  }
  return { allocated: result, remaining: poolCopy };
}

function autoAllocatePool() {
  const accountsList = loadAccountsList();
  const accountIds = accountsList.map((a) => a.id);
  const pool = getPool();
  const existingByAccount = {};
  for (const id of accountIds) existingByAccount[id] = getCustomers(id);

  const { allocated, remaining } = allocatePoolAcrossAccounts(pool, accountIds, existingByAccount);

  for (const id of accountIds) saveCustomersFor(id, allocated[id]);
  savePool(remaining);

  const perAccount = accountsList.map((a) => ({ id: a.id, label: a.label, total: allocated[a.id].length }));
  return { perAccount, remainingInPool: remaining.length };
}

// Pure function: given accounts (in the order selected) each with their own
// customer list, take customers in order until `totalClients` is reached.
function pickCustomersForMasterBroadcast(accountsWithCustomers, totalClients) {
  const perAccountSelection = {};
  let remaining = totalClients;
  for (const acc of accountsWithCustomers) {
    if (remaining <= 0) {
      perAccountSelection[acc.id] = [];
      continue;
    }
    const take = Math.min(remaining, acc.customers.length);
    perAccountSelection[acc.id] = acc.customers.slice(0, take);
    remaining -= take;
  }
  return perAccountSelection;
}

// Pure function: remove the customers that were just messaged from a list,
// matched by number, leaving anything not included in this batch untouched.
function removeSentCustomers(fullList, sentList) {
  const sentNumbers = new Set(sentList.map((c) => c.number));
  return fullList.filter((c) => !sentNumbers.has(c.number));
}

async function checkSessionValid(id) {
  const state = runtime.get(id);
  if (!state || !state.client || !state.isReady) return false;
  try {
    const waState = await state.client.getState();
    return waState === 'CONNECTED';
  } catch (err) {
    return false;
  }
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
app.get('/manager', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager-list.html'));
});
app.get('/manager/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});
app.get('/master', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'master.html'));
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

// Bulk upload: accepts contacts already parsed to JSON on the client side
// (works for both uploaded .json and .csv files — CSV parsing happens in
// the browser before this is called). Adds valid, non-duplicate contacts to
// the shared pool, then immediately auto-allocates across all accounts.
app.post('/api/admin/upload-contacts', requireAdminAuth, (req, res) => {
  const raw = req.body.contacts;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'contacts must be an array' });

  const existingNumbers = getAllExistingNumbers();
  let added = 0;
  let invalidSkipped = 0;
  let duplicateSkipped = 0;
  const pool = getPool();

  for (const entry of raw) {
    const normalized = normalizeContact(entry);
    if (!normalized) {
      invalidSkipped++;
      continue;
    }
    if (existingNumbers.has(normalized.number)) {
      duplicateSkipped++;
      continue;
    }
    pool.push(normalized);
    existingNumbers.add(normalized.number);
    added++;
  }
  savePool(pool);

  const allocation = autoAllocatePool();

  res.json({
    ok: true,
    received: raw.length,
    added,
    invalidSkipped,
    duplicateSkipped,
    allocation
  });
});

app.get('/api/admin/pool', requireAdminAuth, (req, res) => {
  res.json({ remaining: getPool().length });
});

// Lightweight, ungated listing used by the Manager page — only exposes
// label/connection status, nothing about customers or messages.
app.get('/api/manager/accounts', (req, res) => {
  const list = loadAccountsList();
  const withStatus = list.map((a) => {
    const state = runtime.get(a.id) || {};
    return { id: a.id, label: a.label, isReady: !!state.isReady, statusMessage: state.statusMessage || 'Unknown' };
  });
  res.json(withStatus);
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
    const digits = applyIndianCountryCode(String(entry.number || '').replace(/\D/g, ''));
    if (digits.length < 8) {
      return res.status(400).json({ error: `Invalid number for ${entry.name}.` });
    }
    entry.number = digits;
  }

  saveCustomersFor(req.params.id, list);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/session-check', requireAccount, async (req, res) => {
  const valid = await checkSessionValid(req.params.id);
  res.json({ valid });
});

app.get('/api/accounts/:id/log', requireAccount, (req, res) => {
  res.json(runtime.get(req.params.id).sendLog);
});

// Send the same message to every customer of this account, one at a time,
// with a random delay between each send. Once the whole batch is done, this
// account's customer list is cleared so the next upload/allocation doesn't
// risk messaging the same people twice.
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

  // Broadcast batch finished — clear this account's list so a future
  // upload/allocation round can't accidentally message these people again.
  saveCustomersFor(id, []);
});

// ---- Master broadcast: send one message across multiple accounts at once ----
let masterLog = { startedAt: null, perAccount: {} };

app.get('/api/master/log', requireAdminAuth, (req, res) => {
  res.json(masterLog);
});

app.post('/api/master/send', requireAdminAuth, async (req, res) => {
  const { accountIds, totalClients, message } = req.body;

  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one account.' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  const total = parseInt(totalClients, 10);
  if (!total || total <= 0) {
    return res.status(400).json({ error: 'Enter a valid total number of clients.' });
  }

  // Session validity check: confirm each selected number is actually still
  // connected before including it, rather than finding out mid-broadcast.
  const validAccountIds = [];
  const skippedAccounts = [];
  for (const id of accountIds) {
    if (!runtime.has(id)) {
      skippedAccounts.push({ id, reason: 'Account not found.' });
      continue;
    }
    const valid = await checkSessionValid(id);
    if (!valid) {
      skippedAccounts.push({ id, label: runtime.get(id).label, reason: 'WhatsApp session is not active.' });
      continue;
    }
    validAccountIds.push(id);
  }

  const accountsWithCustomers = validAccountIds.map((id) => ({ id, customers: getCustomers(id) }));
  const selection = pickCustomersForMasterBroadcast(accountsWithCustomers, total);
  const totalQueued = Object.values(selection).reduce((sum, list) => sum + list.length, 0);

  res.json({
    ok: true,
    queuedAccounts: validAccountIds.length,
    skippedAccounts,
    totalQueued
  });

  masterLog = { startedAt: new Date().toISOString(), perAccount: {} };
  for (const id of validAccountIds) masterLog.perAccount[id] = { label: runtime.get(id).label, entries: [] };

  await Promise.all(validAccountIds.map(async (id) => {
    const state = runtime.get(id);
    const customersToSend = selection[id] || [];
    for (const customer of customersToSend) {
      const number = String(customer.number).replace(/\D/g, '');
      const chatId = `${number}@c.us`;
      try {
        const personalized = message.replace(/\{name\}/g, customer.name || '');
        await state.client.sendMessage(chatId, personalized);
        masterLog.perAccount[id].entries.push({ name: customer.name, number, status: 'sent', time: new Date().toISOString() });
      } catch (err) {
        masterLog.perAccount[id].entries.push({ name: customer.name, number, status: 'failed', error: err.message, time: new Date().toISOString() });
      }
      const delay = 4000 + Math.floor(Math.random() * 6000);
      await sleep(delay);
    }
    // Remove only the customers actually included in this batch, so anyone
    // left over (due to the totalClients cap) stays for next time.
    const remaining = removeSentCustomers(getCustomers(id), customersToSend);
    saveCustomersFor(id, remaining);
  }));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = {
  allocatePoolAcrossAccounts,
  pickCustomersForMasterBroadcast,
  removeSentCustomers,
  normalizeContact,
  applyIndianCountryCode
};
