// Logs into the school parent portal and saves a day's diary entry locally.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sendToWhatsApp, closeWhatsApp } = require('./whatsapp');

const LOGIN_URL = process.env.PORTAL_URL;
const OUTPUT_DIR = path.join(__dirname, 'diary');
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, 'attachments');
const HEADLESS = process.env.HEADLESS === 'true'; // defaults to visible; set HEADLESS=true to run hidden

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toISO(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Matches the site's date format in the diary table, e.g. "30 Sep 2026".
function toSiteFormat(d) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Accepts "YYYY-MM-DD", "Sep 24", "Sep 24 2026", etc. Missing year defaults to the current year.
// Returns a Date at local midnight, or null if unparseable.
function parseTargetDate(input) {
  if (!input) return null;
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const hasYear = /\d{4}/.test(input);
  const parsed = new Date(hasYear ? input : `${input} ${new Date().getFullYear()}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse date "${input}". Use "YYYY-MM-DD" or e.g. "Sep 24".`);
  }
  return parsed;
}

// Inclusive list of Dates from `from` to `to` (order-independent), one per day.
function dateRange(from, to) {
  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }
  return dates;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDiaryHtml(date, diaryData, savedAttachments) {
  const rowsHtml = diaryData.rows
    .map(
      (r) => `<tr>
        <td class="sno">${escapeHtml(r.sno)}</td>
        <td>${escapeHtml(r.subject)}</td>
        <td>${escapeHtml(r.classWork)}</td>
        <td>${escapeHtml(r.homeWork)}</td>
        <td>${escapeHtml(r.classActivity)}</td>
        <td>${escapeHtml(r.hwSubmissionDate)}</td>
      </tr>`
    )
    .join('\n');

  const announcementHtml = diaryData.announcement
    ? escapeHtml(diaryData.announcement).replace(/\n/g, '<br>')
    : '<em>No announcements for today.</em>';

  const attachmentsNoteHtml =
    savedAttachments && savedAttachments.length > 0
      ? `<div class="attachments-note">
          <strong>Attachments:</strong>
          <ul>
            ${savedAttachments
              .map(
                (a) =>
                  `<li>${escapeHtml(a.subject)} — "${escapeHtml(a.filename)}" saved to ${escapeHtml(a.path)}</li>`
              )
              .join('\n')}
          </ul>
        </div>`
      : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.4; color: #222; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .subtitle { color: #666; margin: 0 0 12px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  td.sno { width: 30px; text-align: center; }
  .announcements-page { page-break-before: always; }
  .announcements-page h1 { margin-bottom: 12px; }
  .attachments-note { margin-top: 10px; font-size: 12px; color: #444; }
  .attachments-note ul { margin: 4px 0 0; padding-left: 18px; }
</style>
</head>
<body>
  <h1>Daily Diary — ${escapeHtml(date)}</h1>
  <table>
    <thead>
      <tr>
        <th>S.no</th>
        <th>Subject</th>
        <th>Class work</th>
        <th>Home work</th>
        <th>Class Activity</th>
        <th>Home work submission date</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
  ${attachmentsNoteHtml}

  <div class="announcements-page">
    <h1>Announcements — ${escapeHtml(date)}</h1>
    <p>${announcementHtml}</p>
  </div>
</body>
</html>`;
}

function filenameFromResponse(response, url, fallbackIndex) {
  const disposition = response.headers()['content-disposition'] || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) return decodeURIComponent(match[1]);
  const base = decodeURIComponent(path.basename(new URL(url).pathname));
  return base && base !== '/' ? base : `attachment-${fallbackIndex}`;
}

async function downloadAttachments(page, date, attachments) {
  if (!attachments || attachments.length === 0) return [];

  const destDir = path.join(ATTACHMENTS_DIR, date);
  fs.mkdirSync(destDir, { recursive: true });

  const saved = [];
  let index = 1;
  for (const att of attachments) {
    try {
      const response = await page.context().request.get(att.url);
      if (!response.ok()) {
        console.warn(`Skipping attachment (HTTP ${response.status()}): ${att.url}`);
        continue;
      }
      let filename = filenameFromResponse(response, att.url, index);
      let destPath = path.join(destDir, filename);
      while (fs.existsSync(destPath)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}-${index}${ext}`;
        destPath = path.join(destDir, filename);
      }
      fs.writeFileSync(destPath, await response.body());
      saved.push({ subject: att.subject, filename, path: destPath });
      index += 1;
    } catch (err) {
      console.warn(`Failed to download attachment ${att.url}: ${err.message}`);
    }
  }
  return saved;
}

async function renderDiaryPdf(date, diaryData, savedAttachments) {
  const html = buildDiaryHtml(date, diaryData, savedAttachments);
  // PDF export only works in headless Chromium, regardless of how the scraping browser was launched,
  // so use a dedicated headless browser for this step.
  const pdfBrowser = await chromium.launch({ headless: true });
  try {
    const page = await pdfBrowser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', landscape: false, printBackground: true });
  } finally {
    await pdfBrowser.close();
  }
}

async function login(page, USID, PASSWORD) {
  console.log('Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';

  console.log('Submitting USID...');
  await page.fill('#usid', USID);
  // "Password" login mode is selected by default; submit step 1 (USID).
  await page.click(SUBMIT_SELECTOR);
  await page.waitForLoadState('networkidle');

  const usidError = await page.locator('text=Enter Valid USID').count();
  if (usidError > 0) {
    throw new Error('Login failed: USID was rejected. Check the USID value in .env.');
  }

  console.log('Submitting password...');
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: 15000 });
  await passwordField.fill(PASSWORD);
  await page.click(SUBMIT_SELECTOR);
  await page.waitForLoadState('networkidle');

  const stillOnLogin = await page.locator('#usid').count();
  if (stillOnLogin > 0) {
    throw new Error('Login failed: still on the login page after submitting password. Check credentials, or the page structure may have changed.');
  }
}

async function goToDiaryList(page) {
  console.log('Navigating to Academics > Daily Dairy...');
  const academicsLink = page.locator('a, button').filter({ hasText: /academics/i }).first();
  if (await academicsLink.count() > 0) {
    await academicsLink.click();
    await page.waitForLoadState('networkidle');
  } else {
    console.warn('No "Academics" menu item found — falling back to a page-wide search for a diary link.');
  }

  const dailyDairyLink = page.locator('a, button').filter({ hasText: /daily\s*dairy|daily\s*diary/i }).first();
  if (await dailyDairyLink.count() > 0) {
    await dailyDairyLink.click();
    await page.waitForLoadState('networkidle');
  } else {
    const diaryLink = page.locator('a, button').filter({ hasText: /diary/i }).first();
    if (await diaryLink.count() > 0) {
      await diaryLink.click();
      await page.waitForLoadState('networkidle');
    } else {
      console.warn('No diary link found by text match — assuming diary content is on the current page.');
    }
  }

  return page.url();
}

// Extracts the diary table for whatever date is currently displayed in the "View Diary" view.
async function extractDiaryData(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const table = tables.find((t) => t.innerText.includes('S.no') && t.innerText.includes('Subject'));
    if (!table) return null;

    const rows = Array.from(table.querySelectorAll('tr'));
    let announcement = '';
    const dataRows = [];
    const attachments = [];

    const extractAttachments = (row, subjectLabel) => {
      const links = Array.from(row.querySelectorAll('a[href]')).filter((a) => {
        const href = a.getAttribute('href') || '';
        return href && !href.startsWith('javascript:') && href !== '#';
      });
      for (const a of links) {
        attachments.push({
          subject: subjectLabel,
          url: new URL(a.getAttribute('href'), window.location.href).toString(),
          text: a.innerText.trim() || a.getAttribute('href'),
        });
      }
    };

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td,th')).map((c) => c.innerText.trim());
      if (cells.length === 0) continue;
      if (/^\d+$/.test(cells[0])) {
        dataRows.push({
          sno: cells[0],
          subject: cells[1] || '',
          classWork: cells[2] || '',
          homeWork: cells[3] || '',
          classActivity: cells[4] || '',
          hwSubmissionDate: cells[5] || '',
        });
        extractAttachments(row, cells[1] || `Row ${cells[0]}`);
      } else if (/announcement/i.test(cells[0])) {
        announcement = cells.slice(1).join('\n').trim();
        extractAttachments(row, 'Announcement');
      } else if (/attachment/i.test(cells[0])) {
        extractAttachments(row, 'Attachment');
      }
    }

    return { rows: dataRows, announcement, attachments };
  });
}

// The diary list's S.No of its topmost row (a running index across all pages, e.g. "1" on
// page 1, "61" on a later page) — used to confirm the AJAX-paginated table has actually
// finished updating after a pagination click, since it isn't reliably a real navigation.
async function firstRowSno(page) {
  const cell = page.locator('table td, table th').filter({ hasText: /^\d+$/ }).first();
  if ((await cell.count()) === 0) return null;
  return (await cell.innerText()).trim();
}

// Clicks a pagination control and waits for the table's topmost row to actually change,
// rather than trusting waitForLoadState('networkidle') — pagination here is AJAX-driven
// and content can still be mid-update once network activity looks idle, which was causing
// the row search to run against stale content and miss entries that were really there.
async function clickPaginationControl(page, locator) {
  const before = await firstRowSno(page);
  await locator.click();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const after = await firstRowSno(page);
    if (after !== null && after !== before) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

// Clicks the pagination link for an exact page number (e.g. "2"), not "Next"/"Previous" —
// those proved unreliable (clicks not always advancing/resetting the table as expected).
// Returns true if the link was found, clicked, and the table content changed.
async function clickPageNumber(page, n) {
  const link = page.locator('a, button').filter({ hasText: new RegExp(`^${n}$`) }).first();
  if ((await link.count()) === 0) return false;
  return clickPaginationControl(page, link);
}

async function clickNext(page) {
  const nextButton = page.locator('a, button').filter({ hasText: /^next$/i }).first();
  if ((await nextButton.count()) === 0) return false;
  const disabled = await nextButton.evaluate(
    (el) => el.classList.contains('disabled') || el.closest('.disabled') != null || el.getAttribute('aria-disabled') === 'true'
  );
  if (disabled) return false;
  return clickPaginationControl(page, nextButton);
}

async function clickPrevious(page) {
  const prevButton = page.locator('a, button').filter({ hasText: /^previous$/i }).first();
  if ((await prevButton.count()) === 0) return false;
  const disabled = await prevButton.evaluate(
    (el) => el.classList.contains('disabled') || el.closest('.disabled') != null || el.getAttribute('aria-disabled') === 'true'
  );
  if (disabled) return false;
  return clickPaginationControl(page, prevButton);
}

// Clicks back to page 1 by number; if "1" isn't in the current pagination window,
// clicks "Previous" to shift the window back until it is.
async function resetToFirstPage(page) {
  if ((await firstRowSno(page)) === '1') return;
  for (let i = 0; i < 20; i += 1) {
    if (await clickPageNumber(page, 1)) return;
    if ((await firstRowSno(page)) === '1') return;
    if (!(await clickPrevious(page))) return;
    if ((await firstRowSno(page)) === '1') return;
  }
}

// Parses a site-formatted date like "24 Sep 2026" back into a Date, or null.
function parseSiteDateStr(str) {
  const m = str.match(/(\d{1,2}) (\w{3}) (\d{4})/);
  if (!m) return null;
  const idx = MONTHS.indexOf(m[2]);
  if (idx === -1) return null;
  return new Date(Number(m[3]), idx, Number(m[1]));
}

// The oldest (smallest) date currently visible anywhere on the page, or null.
async function oldestDateOnPage(page) {
  const text = await page.locator('body').innerText();
  const dates = (text.match(/\d{1,2} \w{3} \d{4}/g) || []).map(parseSiteDateStr).filter(Boolean);
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

// Finds and opens the diary entry for `targetDate` from the diary list page (paginating if needed).
// Returns true if the entry was found and opened, false otherwise.
async function openDiaryEntry(page, targetDate, targetLabel) {
  let targetRow = page.locator('tr', { hasText: targetLabel }).first();
  let rowFound = (await targetRow.count()) > 0;

  const MAX_PAGES = 20;
  let currentPage = 1;
  while (!rowFound && currentPage < MAX_PAGES) {
    const nextPage = currentPage + 1;
    if (await clickPageNumber(page, nextPage)) {
      currentPage = nextPage;
    } else if (await clickNext(page)) {
      // Desired page number wasn't in the current pagination window; "Next" shifts it.
      currentPage += 1;
    } else {
      break;
    }
    targetRow = page.locator('tr', { hasText: targetLabel }).first();
    rowFound = (await targetRow.count()) > 0;
    if (!rowFound) {
      // The list is sorted newest-to-oldest: once this page's oldest visible date is
      // older than what we're looking for, the target can't exist further on — stop
      // instead of scanning every remaining page (this mattered for non-school days,
      // which otherwise triggered a full scan to the last page every time).
      const oldest = await oldestDateOnPage(page);
      if (oldest && oldest < targetDate) break;
    }
  }

  if (!rowFound) return false;

  const actionControl = targetRow.locator('button, a, [role="button"]').filter({ hasText: /actions/i }).first();
  if ((await actionControl.count()) === 0) return false;

  await actionControl.click();
  const viewDiaryLink = targetRow.locator('a, button').filter({ hasText: /view diary/i }).first();
  await viewDiaryLink.waitFor({ state: 'visible', timeout: 5000 });
  await viewDiaryLink.click();
  await page.waitForLoadState('networkidle');
  return true;
}

// Fetches and saves the diary PDF for one date. Assumes the page is currently on the diary list.
async function fetchOneDate(page, targetDate) {
  const targetLabel = toSiteFormat(targetDate);
  const date = toISO(targetDate);
  console.log(`\n=== ${targetLabel} ===`);

  console.log(`Looking for the ${targetLabel} row in the diary table...`);
  const opened = await openDiaryEntry(page, targetDate, targetLabel);
  if (!opened) {
    console.warn(`No diary entry found for "${targetLabel}" — skipping.`);
    return false;
  }

  console.log('Extracting diary table...');
  const diaryData = await extractDiaryData(page);
  if (!diaryData || diaryData.rows.length === 0) {
    console.warn(`Diary table for "${targetLabel}" looked empty — skipping.`);
    return false;
  }

  let savedAttachments = [];
  if (diaryData.attachments.length > 0) {
    console.log(`Downloading ${diaryData.attachments.length} attachment(s) to ${path.join(ATTACHMENTS_DIR, date)}...`);
    savedAttachments = await downloadAttachments(page, date, diaryData.attachments);
  }

  const pdfBuffer = await renderDiaryPdf(date, diaryData, savedAttachments);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${date}.pdf`);
  fs.writeFileSync(outPath, pdfBuffer);

  console.log(`Saved diary PDF to ${outPath}`);

  try {
    await sendToWhatsApp(outPath, `Diary — ${targetLabel}`);
  } catch (err) {
    console.warn(`Failed to send ${date} to WhatsApp: ${err.message}`);
  }

  return true;
}

function resolveDates() {
  const [fromArg, toArg] = process.argv.slice(2);
  const envFrom = process.env.FROM_DATE;
  const envTo = process.env.TO_DATE;

  if (fromArg && toArg) {
    return dateRange(parseTargetDate(fromArg), parseTargetDate(toArg));
  }
  if (envFrom && envTo) {
    return dateRange(parseTargetDate(envFrom), parseTargetDate(envTo));
  }
  const single = fromArg || process.env.DATE;
  return [single ? parseTargetDate(single) : new Date()];
}

async function main() {
  const { USID, PASSWORD } = process.env;
  if (!USID || !PASSWORD || !LOGIN_URL) {
    throw new Error('Missing USID, PASSWORD, or PORTAL_URL. Copy .env.example to .env and fill in your credentials and portal URL.');
  }

  const dates = resolveDates();
  if (dates.length > 1) {
    console.log(`Date range: ${toSiteFormat(dates[0])} to ${toSiteFormat(dates[dates.length - 1])} (${dates.length} days)`);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  const results = [];
  try {
    await login(page, USID, PASSWORD);

    const diaryListUrl = await goToDiaryList(page);

    for (let i = 0; i < dates.length; i += 1) {
      const targetDate = dates[i];
      if (i > 0) {
        // Pagination position is remembered (survives a same-URL page.goto() and a
        // full reload, likely server-session state), so explicitly click back to
        // page 1 rather than relying on navigation to reset it.
        if (page.url() !== diaryListUrl) {
          await page.goto(diaryListUrl, { waitUntil: 'networkidle' });
        }
        await resetToFirstPage(page);
      }
      try {
        const ok = await fetchOneDate(page, targetDate);
        results.push({ date: toISO(targetDate), ok });
      } catch (err) {
        console.error(`Failed for ${toSiteFormat(targetDate)}: ${err.message}`);
        results.push({ date: toISO(targetDate), ok: false });
      }
    }
  } catch (err) {
    const debugPath = path.join(__dirname, 'last-failure.png');
    try {
      await page.screenshot({ path: debugPath, fullPage: true });
      console.error(`Failure screenshot saved to ${debugPath}`);
    } catch (_) {
      // ignore screenshot errors
    }
    throw err;
  } finally {
    await browser.close();
    await closeWhatsApp();
  }

  if (results.length > 1) {
    const succeeded = results.filter((r) => r.ok).map((r) => r.date);
    const failed = results.filter((r) => !r.ok).map((r) => r.date);
    console.log(`\nDone: ${succeeded.length} saved, ${failed.length} skipped/failed.`);
    if (failed.length > 0) console.log(`Skipped/failed dates: ${failed.join(', ')}`);
  } else if (!results[0]?.ok) {
    throw new Error(`No diary entry found for ${toSiteFormat(dates[0])}.`);
  }
}

main().catch((err) => {
  console.error('Failed to fetch diary:', err.message);
  process.exit(1);
});
