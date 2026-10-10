/**
 * Christ Nation – website form -> Telegram relay (Vercel serverless function)
 *
 * The bot token and chat id are NOT in the website code. Set them in
 * Vercel -> Project -> Settings -> Environment Variables:
 *     TELEGRAM_BOT_TOKEN   (from @BotFather)
 *     TELEGRAM_CHAT_ID     (the chat / group that should receive messages)
 * then redeploy.
 *
 * POST /api/telegram?action=message   JSON body  -> formatted text message
 * POST /api/telegram?action=file      binary body -> photo / document (reply to the message)
 */

const MAX_FILE = 4 * 1024 * 1024; // Vercel's request limit is ~4.5 MB
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const hits = new Map(); // tiny in-memory rate limit (per server instance)

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\r/g, '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const strip = (html) => html.replace(/<\/?(b|i|code|blockquote)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function lagosTime() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date()).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM');
}

function makeRef() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return 'CN-' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + Math.floor(1000 + Math.random() * 9000);
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_FILE + 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the nicely formatted Telegram message (HTML mode). */
function buildMessage(p, ref) {
  const line = '━━━━━━━━━━━━━━━━━━';
  const out = [];
  out.push(`${esc(clip(p.icon || '📩', 12))} <b>${esc(clip(p.title || 'NEW MESSAGE', 80))}</b>`);
  out.push(`🆔 <b>Ref:</b> <code>${esc(ref)}</code>`);
  out.push(line);
  const sections = Array.isArray(p.sections) ? p.sections.slice(0, 12) : [];
  for (const sec of sections) {
    const rows = (Array.isArray(sec.rows) ? sec.rows.slice(0, 30) : [])
      .map((r) => [clip(r && r[0], 60), clip(r && r[1], 1200)])
      .filter((r) => r[0] && r[1]);
    if (!rows.length) continue;
    out.push('');
    out.push(`${esc(clip(sec.icon || '▪️', 12))} <b>${esc(clip(sec.title, 60).toUpperCase())}</b>`);
    for (const [k, v] of rows) {
      if (v.length > 60 || v.indexOf('\n') !== -1) out.push(`<b>${esc(k)}:</b>\n<blockquote>${esc(v)}</blockquote>`);
      else out.push(`<b>${esc(k)}:</b> ${esc(v)}`);
    }
  }
  out.push('');
  out.push(line);
  if (p.attachments) out.push(`📎 <b>Attachments:</b> ${esc(clip(p.attachments, 200))}`);
  out.push(`🕒 ${esc(lagosTime())}`);
  if (p.source) out.push(`🌐 ${esc(clip(p.source, 120))}`);
  return out.join('\n');
}

function chunkText(text, size = 3900) {
  if (text.length <= size) return [text];
  const parts = []; let cur = '';
  for (const l of text.split('\n')) {
    if ((cur + '\n' + l).length > size) { parts.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', ...body });
  let data = null; try { data = await r.json(); } catch (e) { /* ignore */ }
  return data || { ok: false, description: 'No response from Telegram' };
}

async function sendText(token, chat, html, replyTo) {
  const base = { chat_id: chat, disable_web_page_preview: true };
  if (replyTo) { base.reply_to_message_id = replyTo; base.allow_sending_without_reply = true; }
  let data = await tg(token, 'sendMessage', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, text: html, parse_mode: 'HTML' }) });
  if (!data.ok && /parse|entit/i.test(data.description || '')) {
    data = await tg(token, 'sendMessage', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, text: strip(html) }) });
  }
  return data;
}

function magicOk(buf, mime) {
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'application/pdf') return buf.slice(0, 5).toString('latin1') === '%PDF-';
  return false;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

    const token = '8914904938:AAFa35H3-ZCv9iwCDNUt35eLD4acZBpewhs', chat = '8854936887';
    if (!token || !chat) return send(res, 500, { ok: false, error: 'The form service is not set up yet. Please contact us directly.' });

    // Only accept requests coming from our own website
    const origin = req.headers.origin;
    if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch (e) { /* ignore */ } if (!ok) return send(res, 403, { ok: false, error: 'Forbidden' }); }

    // Light rate limit: 30 requests / 10 min / IP
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    const now = Date.now(); const recent = (hits.get(ip) || []).filter((t) => now - t < 600000);
    if (recent.length >= 30) return send(res, 429, { ok: false, error: 'Too many requests. Please wait a few minutes and try again.' });
    recent.push(now); hits.set(ip, recent);

    const q = new URL(req.url, 'http://localhost').searchParams;
    const action = q.get('action') || 'message';

    /* ---------- TEXT MESSAGE ---------- */
    if (action === 'message') {
      let p = req.body;
      if (Buffer.isBuffer(p)) p = p.toString('utf8');
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
      if (!p || typeof p !== 'object') return send(res, 400, { ok: false, error: 'Bad request' });

      const ref = makeRef();
      const parts = chunkText(buildMessage(p, ref));
      let first = null;
      for (let i = 0; i < parts.length; i++) {
        const d = await sendText(token, chat, parts[i], i === 0 ? null : first);
        if (!d.ok) return send(res, 502, { ok: false, error: 'Telegram: ' + (d.description || 'could not send') });
        if (i === 0) first = d.result.message_id;
      }
      return send(res, 200, { ok: true, ref, message_id: first });
    }

    /* ---------- FILE (photo / document) ---------- */
    if (action === 'file') {
      let buf = req.body;
      if (buf === undefined || buf === null || buf === '') buf = await readStream(req);
      if (!Buffer.isBuffer(buf)) return send(res, 400, { ok: false, error: 'Unexpected upload format' });
      if (buf.length === 0) return send(res, 400, { ok: false, error: 'Empty file' });
      if (buf.length > MAX_FILE) return send(res, 413, { ok: false, error: 'File is too large (max 4 MB).' });

      const mime = String(q.get('mime') || '').toLowerCase();
      if (!ALLOWED[mime] || !magicOk(buf, mime)) return send(res, 415, { ok: false, error: 'Only JPG, PNG or PDF files are allowed.' });

      const ext = ALLOWED[mime];
      let name = String(q.get('name') || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
      if (!name.toLowerCase().endsWith('.' + ext)) name = name.replace(/\.[^.]*$/, '') + '.' + ext;

      const ref = clip(q.get('ref'), 30), label = clip(q.get('label') || 'Attachment', 60), who = clip(q.get('who'), 80);
      const reply = parseInt(q.get('reply'), 10);
      const caption = `📎 <b>${esc(label)}</b>` + (who ? `\n👦 ${esc(who)}` : '') + (ref ? `\n🆔 <code>${esc(ref)}</code>` : '');
      const wantPhoto = q.get('photo') === '1' && mime !== 'application/pdf';

      const upload = (method, field) => {
        const fd = new FormData();
        fd.append('chat_id', chat);
        fd.append(field, new Blob([buf], { type: mime }), name);
        fd.append('caption', caption);
        fd.append('parse_mode', 'HTML');
        if (reply) { fd.append('reply_to_message_id', String(reply)); fd.append('allow_sending_without_reply', 'true'); }
        return tg(token, method, { body: fd });
      };

      let d = wantPhoto ? await upload('sendPhoto', 'photo') : await upload('sendDocument', 'document');
      if (!d.ok && wantPhoto) d = await upload('sendDocument', 'document'); // photo rejected (odd dimensions) -> send as file
      if (!d.ok) return send(res, 502, { ok: false, error: 'Telegram: ' + (d.description || 'could not send file') });
      return send(res, 200, { ok: true, message_id: d.result.message_id });
    }

    return send(res, 400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    return send(res, err && err.status ? err.status : 500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};
