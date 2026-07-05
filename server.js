const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Explicit fallback so "/" always serves the UI even if static resolution
// has issues (e.g. public/ missing in a deploy).
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(500).send(
      'public/index.html not found on the server. ' +
      'This usually means the public/ folder was not included in your deploy — ' +
      'check that it is committed to your git repo and not excluded by .gitignore.'
    );
  }
});

const PORT = process.env.PORT || 3000;
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
const CUSTOMERS_FILE = path.join(__dirname, 'customers.json');

let latestQr = null;
let isReady = false;
let statusMessage = 'Starting up...';
let sendLog = [];

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
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

client.on('qr', async (qr) => {
  latestQr = await qrcode.toDataURL(qr);
  isReady = false;
  statusMessage = 'Scan the QR code with WhatsApp (Linked Devices)';
  console.log('QR code generated. Visit /qr to scan.');
});

client.on('ready', () => {
  isReady = true;
  latestQr = null;
  statusMessage = 'Connected. Ready to send messages.';
  console.log('WhatsApp client is ready.');
});

client.on('disconnected', (reason) => {
  isReady = false;
  statusMessage = `Disconnected: ${reason}. Restart the app to reconnect.`;
  console.log('Client disconnected:', reason);
});

client.on('auth_failure', (msg) => {
  isReady = false;
  statusMessage = `Auth failure: ${msg}`;
});

client.initialize();

function getCustomers() {
  try {
    const raw = fs.readFileSync(CUSTOMERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function saveCustomers(list) {
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(list, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- API routes ----

app.get('/api/status', (req, res) => {
  res.json({ isReady, statusMessage, hasQr: !!latestQr });
});

app.get('/api/qr', (req, res) => {
  if (latestQr) return res.json({ qr: latestQr });
  res.json({ qr: null });
});

app.get('/api/customers', (req, res) => {
  res.json(getCustomers());
});

app.post('/api/customers', (req, res) => {
  const list = req.body.customers;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'customers must be an array' });
  saveCustomers(list);
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => {
  res.json(sendLog);
});

// Send the same message to every customer, one at a time, with a random
// delay between each send so it behaves like a human sending messages
// rather than a bot blasting them all instantly.
app.post('/api/send', async (req, res) => {
  const { message } = req.body;
  if (!isReady) return res.status(400).json({ error: 'WhatsApp is not connected yet. Scan the QR code first.' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

  const customers = getCustomers();
  if (customers.length === 0) return res.status(400).json({ error: 'No customers configured.' });

  // Respond immediately, then send in the background so the click doesn't hang.
  res.json({ ok: true, queued: customers.length });

  sendLog = [];
  for (const customer of customers) {
    const number = String(customer.number).replace(/\D/g, '');
    const chatId = `${number}@c.us`;
    try {
      const personalized = message.replace(/\{name\}/g, customer.name || '');
      await client.sendMessage(chatId, personalized);
      sendLog.push({ name: customer.name, number, status: 'sent', time: new Date().toISOString() });
      console.log(`Sent to ${customer.name} (${number})`);
    } catch (err) {
      sendLog.push({ name: customer.name, number, status: 'failed', error: err.message, time: new Date().toISOString() });
      console.error(`Failed to send to ${customer.name} (${number}):`, err.message);
    }
    // Random delay between 4-10 seconds between each message.
    const delay = 4000 + Math.floor(Math.random() * 6000);
    await sleep(delay);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
