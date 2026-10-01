// Phase 2 (rewritten): send a diary PDF to a WhatsApp group via WAHA (self-hosted WhatsApp HTTP API).
// WAHA runs as a Docker container (see README) and handles the actual WhatsApp Web session —
// this module just talks to its REST API, which is far more robust than driving a browser
// with DOM selectors that break whenever WhatsApp Web's UI changes.
const fs = require('fs');
const path = require('path');

const WAHA_URL = process.env.WAHA_URL || 'http://localhost:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY;
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';
const GROUP_NAME = process.env.WHATSAPP_GROUP || 'Babu Study';

async function wahaFetch(urlPath, options = {}) {
  const res = await fetch(`${WAHA_URL}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WAHA ${options.method || 'GET'} ${urlPath} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Finds the group's chatId by name. Set WHATSAPP_CHAT_ID to skip this lookup entirely.
async function findGroupChatId() {
  if (process.env.WHATSAPP_CHAT_ID) return process.env.WHATSAPP_CHAT_ID;

  const chats = await wahaFetch(
    `/api/${WAHA_SESSION}/chats?sortBy=conversationTimestamp&sortOrder=desc&limit=50`
  );
  const match = chats.find((c) => {
    const name = c?.groupMetadata?.subject || c?.name || '';
    return name === GROUP_NAME;
  });
  if (!match) {
    throw new Error(`Could not find a WhatsApp chat named "${GROUP_NAME}". Set WHATSAPP_CHAT_ID to skip lookup.`);
  }
  return match.id._serialized;
}

async function sendToWhatsApp(pdfPath, caption) {
  const status = await wahaFetch(`/api/sessions/${WAHA_SESSION}`);
  if (status.status !== 'WORKING') {
    throw new Error(`WAHA session "${WAHA_SESSION}" is not connected (status: ${status.status}). Scan the QR code in the WAHA dashboard.`);
  }

  console.log(`Looking up WhatsApp group "${GROUP_NAME}"...`);
  const chatId = await findGroupChatId();

  console.log(`Sending ${path.basename(pdfPath)}...`);
  const data = fs.readFileSync(pdfPath).toString('base64');
  await wahaFetch('/api/sendFile', {
    method: 'POST',
    body: JSON.stringify({
      session: WAHA_SESSION,
      chatId,
      caption,
      file: {
        mimetype: 'application/pdf',
        filename: path.basename(pdfPath),
        data,
      },
    }),
  });

  console.log('Sent to WhatsApp.');
}

// No persistent browser/context to close anymore — kept as a no-op so fetch-diary.js
// doesn't need to change its call site.
async function closeWhatsApp() {}

module.exports = { sendToWhatsApp, closeWhatsApp };
