// Images for the Chrome Web Store listing: three 1280x800 screenshots and the
// 440x280 and 1400x560 promo tiles. The popup and banner in them are the real
// built ones, with stand-in answers from Veil, as in screenshots.mjs.
// From extension/: `pnpm build && node scripts/store-assets.mjs`.
// Writes store/*.png (24-bit, no alpha, as the store asks). The store icon is
// static/icon-128.png as it is.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const outDir = 'store';
mkdirSync(outDir, { recursive: true });
const popupUrl = pathToFileURL(resolve('dist/unpacked/popup.html')).href;
const bridge = readFileSync('dist/unpacked/bridge.js', 'utf8');
// The large icon from the Veil repository's design/ when it's there (it isn't
// in veil-chrome), else the extension's own.
const iconFile = existsSync('../design/icon.png') ? '../design/icon.png' : 'static/icon-128.png';
const icon = `data:image/png;base64,${readFileSync(iconFile).toString('base64')}`;
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

// Placeholders are built, not typed, so nothing on the way to this file can
// mistake them for real ones.
const ph = (kind, n = 1) => `<span class="ph">${'\x5b'}${kind}_${n}]</span>`;
const hl = (s) => `<span class="hl">${s}</span>`;

const browser = await chromium.launch();

// ---------------------------------------------------------------- real parts

const ok = {
  ok: true,
  result: { version: '0.1.10', running: true, activated: true, mode: 'redact', fail_closed: true, sites: { 'claude.ai': true, 'chatgpt.com': true } },
};
async function popup(status, count, url) {
  const page = await browser.newPage({ viewport: { width: 320, height: 300 }, deviceScaleFactor: 2 });
  await page.addInitScript((s) => {
    window.chrome = {
      tabs: { query: async () => [{ id: 1, url: s.url }] },
      runtime: { sendMessage: async (m) => (m.op === 'status' ? s.status : s.count) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  }, { status, count, url });
  await page.goto(popupUrl);
  await page.waitForFunction(() => document.getElementById('summary').textContent !== 'Checking…');
  await page.setViewportSize({ width: 320, height: await page.evaluate(() => document.body.scrollHeight) });
  const buf = await page.screenshot();
  await page.close();
  return dataUrl(buf);
}

async function banner() {
  const page = await browser.newPage({ viewport: { width: 700, height: 190 }, deviceScaleFactor: 2 });
  await page.setContent(`<body style="margin:0;height:100vh;background:#fff;color:#333;font:15px system-ui">
    <div style="position:absolute;bottom:22px;left:22px;right:22px;border:1px solid #8884;border-radius:22px;padding:14px 18px">Please send the contract to emily.carter@example.com today</div></body>`);
  await page.evaluate((src) => {
    window.chrome = { runtime: { sendMessage: async () => ({}) }, storage: { local: { get: async () => ({}) } } };
    new Function(src)();
    const { port1, port2 } = new MessageChannel();
    window.postMessage({ __veil: 'hello' }, '*', [port2]);
    setTimeout(() => port1.postMessage({ id: 0, kind: 'blocked', message: "Veil isn't running, so this message was not sent. Open Veil and try again." }), 50);
  }, bridge);
  await page.waitForSelector('veil-banner', { state: 'attached' });
  await page.waitForTimeout(150);
  const buf = await page.screenshot();
  await page.close();
  return dataUrl(buf);
}

const popupOn = await popup(ok, 5, 'https://claude.ai/chat/x');
const popupOff = await popup({ ok: false, error: 'not_running' }, 0, 'https://chatgpt.com/');
const bannerImg = await banner();

// ---------------------------------------------------------------- pages

const css = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  body { font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #151722; background: #f3f4f8; -webkit-font-smoothing: antialiased; }
  .dark { background: radial-gradient(120% 140% at 0% 0%, #2a2d3a 0%, #151722 55%); color: #e7e8f0; }
  h1 { margin: 0; font-weight: 700; letter-spacing: -0.02em; line-height: 1.08; }
  p { margin: 0; }
  .lead { color: #585d6e; line-height: 1.45; }
  .dark .lead { color: #a2a6b4; }
  .hl, .ph { white-space: nowrap; }
  .hl { background: #fbeedc; color: #8a3f06; border-radius: 5px; padding: 1px 5px; font-weight: 500; }
  .ph { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.86em; background: #e7e7e8; color: #35373e; border-radius: 5px; padding: 2px 6px; font-weight: 500; }
  .card { background: #fff; border: 1px solid #dcdee6; border-radius: 16px; box-shadow: 0 10px 30px rgba(21,23,34,.08), 0 1px 2px rgba(21,23,34,.06); }
  .label { font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #585d6e; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 26px; }
  .brand img { width: 44px; height: 44px; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #ecedf2; font-size: 14px; color: #585d6e; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #dcdee6; display: inline-block; }
  .bar .url { margin-left: 10px; background: #f3f4f8; border-radius: 999px; padding: 5px 14px; }
  .msg { font-size: 19px; line-height: 1.75; }
  .shot { border-radius: 14px; box-shadow: 0 18px 50px rgba(21,23,34,.18), 0 2px 4px rgba(21,23,34,.08); border: 1px solid #dcdee6; display: block; }
  .ok { display: inline-flex; align-items: center; gap: 8px; color: #17663a; background: #dff3e6; border-radius: 999px; padding: 6px 14px; font-weight: 600; font-size: 15px; }
`;

const message = `Hi, please draft a reply to ${hl('Emily Carter')} (${hl('emily.carter@example.com')}, ${hl('+1 415 555 0182')}) about the ${hl('Project Lantern')} invoice. Card on file: ${hl('4111 1111 1111 1111')}.`;
const sent = `Hi, please draft a reply to ${ph('PERSON')} (${ph('EMAIL')}, ${ph('PHONE')}) about the ${ph('CODENAME')} invoice. Card on file: ${ph('CARD')}.`;

const pages = {
  'screenshot-1-redact': [1280, 800, `
    <div style="padding:64px 72px;height:100%;display:grid;grid-template-columns:400px 1fr;gap:56px;align-items:center">
      <div style="display:flex;flex-direction:column;gap:24px">
        <div class="brand"><img src="${icon}">Veil</div>
        <h1 style="font-size:46px">Keep private details out of AI chats</h1>
        <p class="lead" style="font-size:20px">Names, emails, phone numbers, card numbers and other sensitive values are replaced on your computer before claude.ai or chatgpt.com send your message.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="card">
          <div class="bar"><i></i><i></i><i></i><span class="url">claude.ai</span></div>
          <div style="padding:22px 26px 26px">
            <div class="label" style="margin-bottom:10px">What you type</div>
            <p class="msg">${message}</p>
          </div>
        </div>
        <div style="text-align:center;font-size:26px;color:#585d6e;line-height:1">↓</div>
        <div class="card" style="padding:22px 26px 26px;background:#fbfbfd">
          <div class="label" style="margin-bottom:10px">What the AI service receives</div>
          <p class="msg">${sent}</p>
        </div>
      </div>
    </div>`],

  'screenshot-2-restore': [1280, 800, `
    <div style="padding:64px 72px;height:100%;display:grid;grid-template-columns:1fr 340px;gap:56px;align-items:center">
      <div style="display:flex;flex-direction:column;gap:26px">
        <h1 style="font-size:42px">Replies come back with your real details</h1>
        <p class="lead" style="font-size:19px;max-width:640px">Veil puts the original values back into the answer, so you read and copy it as if nothing was hidden.</p>
        <div class="card">
          <div class="bar"><i></i><i></i><i></i><span class="url">claude.ai</span></div>
          <div style="padding:22px 26px 26px">
            <div class="label" style="margin-bottom:10px">The reply, as you see it</div>
            <p class="msg">Dear ${hl('Emily Carter')},<br>Thank you for your note about the ${hl('Project Lantern')} invoice. We will charge the card ending ${hl('1111')} this week and send the receipt to ${hl('emily.carter@example.com')}. If anything changes, call me on ${hl('+1 415 555 0182')}.</p>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:18px;align-items:center">
        <img class="shot" src="${popupOn}" style="width:320px">
        <p class="lead" style="font-size:15px;text-align:center">The toolbar button shows how many values were hidden in the tab.</p>
      </div>
    </div>`],

  'screenshot-3-fail-closed': [1280, 800, `
    <div style="padding:64px 72px;height:100%;display:grid;grid-template-columns:1fr 340px;gap:56px;align-items:center">
      <div style="display:flex;flex-direction:column;gap:26px">
        <h1 style="font-size:42px">Nothing slips through when Veil is off</h1>
        <p class="lead" style="font-size:19px;max-width:640px">If the Veil app isn't running, messages on protected sites wait instead of going out unprotected. You choose the sites in Veil.</p>
        <img class="shot" src="${bannerImg}" style="width:700px;max-width:100%">
        <p class="lead" style="font-size:16px">Works with the Veil app for Mac, Windows and Linux. Redaction runs on your computer.</p>
      </div>
      <div style="display:flex;justify-content:center">
        <img class="shot" src="${popupOff}" style="width:320px">
      </div>
    </div>`],

  'promo-small-440x280': [440, 280, `
    <div class="dark" style="height:100%;padding:34px 34px;display:flex;flex-direction:column;justify-content:center;gap:16px">
      <div class="brand" style="font-size:34px;gap:14px"><img src="${icon}" style="width:58px;height:58px">Veil</div>
      <h1 style="font-size:27px;line-height:1.2">Private details stay out of AI chats</h1>
    </div>`],

  'promo-marquee-1400x560': [1400, 560, `
    <div class="dark" style="height:100%;padding:70px 80px;display:grid;grid-template-columns:520px 1fr;gap:64px;align-items:center">
      <div style="display:flex;flex-direction:column;gap:24px">
        <div class="brand" style="font-size:38px;gap:16px"><img src="${icon}" style="width:64px;height:64px">Veil</div>
        <h1 style="font-size:50px">Private details stay out of AI chats</h1>
        <p class="lead" style="font-size:20px">Redacts sensitive values before claude.ai and chatgpt.com send your message, and restores them in the reply.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;color:#151722">
        <div class="card" style="padding:20px 24px"><div class="label" style="margin-bottom:8px">What you type</div><p class="msg" style="font-size:18px">${message}</p></div>
        <div class="card" style="padding:20px 24px;background:#fbfbfd"><div class="label" style="margin-bottom:8px">What the AI receives</div><p class="msg" style="font-size:18px">${sent}</p></div>
      </div>
    </div>`],
};

for (const [name, [width, height, body]] of Object.entries(pages)) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path });
  await page.close();
  // The store takes 24-bit PNG only: drop the alpha channel.
  execFileSync('magick', [path, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', `PNG24:${path}`]);
  console.log(path);
}
await browser.close();
