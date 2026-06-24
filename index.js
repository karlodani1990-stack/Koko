'use strict';

const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.AUTH_TOKEN || '';
const SESSIONS_DIR = '/tmp/wa-sessions';

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory state
const sessions = new Map();   // sessionId -> WASocket
const qrCodes = new Map();    // sessionId -> base64 QR data URL
const statuses = new Map();   // sessionId -> 'connecting' | 'connected' | 'disconnected'

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!TOKEN) return next();
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use(auth);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// ── POST /session/start ───────────────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  if (sessions.has(sessionId)) {
    return res.json({ success: true, message: 'Session already exists' });
  }

  try {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });

    sessions.set(sessionId, sock);
    statuses.set(sessionId, 'connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          qrCodes.set(sessionId, dataUrl);
        } catch (err) {
          console.error(`QR generation failed for ${sessionId}:`, err.message);
        }
      }

      if (connection === 'open') {
        statuses.set(sessionId, 'connected');
        qrCodes.delete(sessionId);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        statuses.set(sessionId, 'disconnected');
        sessions.delete(sessionId);
        qrCodes.delete(sessionId);
        console.log(`Session ${sessionId} closed. Reconnect: ${shouldReconnect}`);
      }
    });

    res.json({ success: true, sessionId });
  } catch (err) {
    console.error(`Failed to start session ${sessionId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /session/qr/:sessionId ────────────────────────────────────────────────
app.get('/session/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes.get(sessionId);
  if (!qr) return res.status(404).json({ error: 'QR code not available yet' });
  res.json({ sessionId, qr });
});

// ── GET /session/status/:sessionId ───────────────────────────────────────────
app.get('/session/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sock = sessions.get(sessionId);
  const status = statuses.get(sessionId) || 'not_found';
  const phone = sock?.user?.id?.split(':')[0] || null;
  res.json({ sessionId, status, phone });
});

// ── POST /message/send ────────────────────────────────────────────────────────
app.post('/message/send', async (req, res) => {
  const { sessionId, to, message } = req.body;
  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: 'sessionId, to, and message are required' });
  }

  const sock = sessions.get(sessionId);
  if (!sock) return res.status(404).json({ error: 'Session not found' });

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error(`Failed to send message for ${sessionId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /session/disconnect/:sessionId ─────────────────────────────────────
app.delete('/session/disconnect/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sock = sessions.get(sessionId);

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      console.error(`Logout error for ${sessionId}:`, err.message);
    }
    sessions.delete(sessionId);
    qrCodes.delete(sessionId);
    statuses.delete(sessionId);
  }

  res.json({ success: true });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
});
