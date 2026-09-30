// Phase 2: send a diary PDF to a WhatsApp group via WhatsApp Web automation.
const path = require('path');
const { chromium } = require('playwright');

const SESSION_DIR = path.join(__dirname, 'whatsapp-session');
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const GROUP_NAME = process.env.WHATSAPP_GROUP || 'Babu Study';

let context = null;
let page = null;

async function getPage() {
  if (page) return page;

  const headless = process.env.HEADLESS === 'true';
  context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless, // visible by default so a first-time QR scan is possible; HEADLESS=true hides it
  });
  page = context.pages()[0] || (await context.newPage());
  await page.goto(WHATSAPP_URL, { waitUntil: 'domcontentloaded' });

  // In headless (unattended/scheduled) runs nobody can scan a QR code, so fail fast
  // instead of sitting through the full interactive wait with no one there to act on it.
  const loginTimeoutMs = headless ? 30000 : 300000;
  const loggedIn = await waitForLogin(page, loginTimeoutMs);
  if (!loggedIn) {
    throw new Error('WhatsApp Web login timed out. Scan the QR code in the opened browser window and try again.');
  }
  await dismissModals(page);

  return page;
}

// WhatsApp Web occasionally shows a "What's new" / announcement dialog on top of the
// chat list after login, which blocks clicks on the search box underneath it even
// though the search box technically exists in the DOM. Dismiss it if present.
async function dismissModals(page) {
  const dismissButton = page
    .locator('button', { hasText: /^(continue|ok|got it|not now)$/i })
    .first();
  if ((await dismissButton.count()) > 0 && (await dismissButton.isVisible())) {
    await dismissButton.click();
    await page.waitForTimeout(300);
  }
}

async function waitForLogin(page, timeoutMs = 300000) {
  const searchBox = page.locator('input[aria-label="Search or start a new chat"]').first();
  const qrCanvas = page.locator('canvas[aria-label*="scan" i]').first();

  const deadline = Date.now() + timeoutMs;
  let loggedWaitingMessage = false;
  while (Date.now() < deadline) {
    if (await searchBox.count() > 0) return true;
    if (!loggedWaitingMessage && (await qrCanvas.count()) > 0) {
      console.log('WhatsApp Web: scan the QR code in the opened browser window to log in...');
      loggedWaitingMessage = true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function sendToWhatsApp(pdfPath, caption) {
  const p = await getPage();
  await dismissModals(p);

  console.log(`Opening WhatsApp group "${GROUP_NAME}"...`);
  const searchBox = p.locator('input[aria-label="Search or start a new chat"]').first();
  await searchBox.click();
  await searchBox.fill(GROUP_NAME);
  await p.waitForTimeout(1000);

  const chatResult = p.locator('span[title]', { hasText: GROUP_NAME }).first();
  await chatResult.waitFor({ state: 'visible', timeout: 10000 });
  await chatResult.click();

  console.log(`Attaching ${path.basename(pdfPath)}...`);
  const attachButton = p.locator('button[aria-label="Attach"]').first();
  await attachButton.click();

  const docOption = p.getByText('Document', { exact: true }).first();
  await docOption.waitFor({ state: 'visible', timeout: 10000 });
  await docOption.click({ force: true });

  // The attach menu registers a separate hidden file input per type (image, document, ...);
  // the document one is the only one that doesn't restrict to images.
  const fileInput = p.locator('input[type="file"]:not([accept*="image"])').first();
  await fileInput.setInputFiles(pdfPath);

  if (caption) {
    const captionBox = p.locator('div[aria-label="Type a message"]').first();
    await captionBox.waitFor({ state: 'visible', timeout: 10000 });
    await captionBox.click();
    await captionBox.fill(caption);
  }

  const sendButton = p.locator('div[aria-label="Send 1 selected"], [data-icon="wds-ic-send-filled"]').first();
  await sendButton.waitFor({ state: 'visible', timeout: 15000 });
  await sendButton.click();

  // Wait for the attachment preview to close, then give WhatsApp Web time to actually
  // upload and deliver the message before the caller closes the browser — clicking send
  // only queues it client-side; closing too soon after can drop it before it's transmitted.
  await fileInput.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(15000);
  console.log('Sent to WhatsApp.');
}

async function closeWhatsApp() {
  if (context) {
    await context.close();
    context = null;
    page = null;
  }
}

module.exports = { sendToWhatsApp, closeWhatsApp };
