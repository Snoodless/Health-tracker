// Cloudflare Worker: напоминания о воде в Telegram + синхронизация с мини-приложением
// Нужны: KV (привязка с именем KV), секреты BOT_TOKEN и SECRET, переменная APP_URL, Cron */15 * * * *

const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
// Проверка подлинности данных, которые Telegram передаёт мини-приложению
async function verify(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const s = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', token);
  if (hex(await hmac(secret, s)) !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

const js = (o, st, h) => new Response(JSON.stringify(o), { status: st || 200, headers: { 'Content-Type': 'application/json', ...h } });
const mins = (s) => { const a = String(s || '0:0').split(':'); return (+a[0] || 0) * 60 + (+a[1] || 0); };
const localNow = (tz) => new Date(Date.now() - (tz || 0) * 60000);
const localDate = (tz) => localNow(tz).toISOString().slice(0, 10);
const fmt = (u, ml) => (u.imp ? (Math.round(ml / 29.57 * 10) / 10) + ' oz' : Math.round(ml) + (u.lang === 'en' ? ' ml' : ' мл'));

async function tg(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r;
}
const kb = (u) => ({ inline_keyboard: [(u.presets || []).map((p) => ({ text: p.l, callback_data: 'w:' + p.ml }))] });
const txt = (u) => (u.lang === 'en'
  ? '💧 Time to drink water. Today: ' + fmt(u, u.total) + ' of ' + fmt(u, u.goal)
  : '💧 Пора выпить воды. Сегодня: ' + fmt(u, u.total) + ' из ' + fmt(u, u.goal));

async function sync(req, env, cors) {
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return js({ error: 'bad' }, 400, cors); }
  const user = await verify(b.initData || '', env.BOT_TOKEN);
  if (!user) return js({ error: 'auth' }, 401, cors);
  const key = 'u:' + user.id;
  const u = JSON.parse((await env.KV.get(key)) || 'null') || { pending: [], last: 0 };
  const pending = u.pending || [];
  u.pending = [];
  u.id = user.id;
  u.tz = +b.tz || 0;
  u.on = !!b.on;
  u.every = Math.max(15, +b.every || 60);
  u.from = b.from || '09:00';
  u.to = b.to || '21:00';
  u.goal = +b.goal || 2000;
  u.imp = !!b.imp;
  u.lang = b.lang === 'en' ? 'en' : 'ru';
  u.date = String(b.date || localDate(u.tz));
  u.total = (+b.total || 0) + pending.filter((p) => p.d === u.date).reduce((a, p) => a + p.ml, 0);
  u.presets = (Array.isArray(b.presets) ? b.presets : []).slice(0, 3)
    .map((p) => ({ l: String(p.l).slice(0, 12), ml: Math.max(1, Math.min(2000, Math.round(+p.ml) || 200)) }));
  if (!u.presets.length) u.presets = [{ l: '+200', ml: 200 }, { l: '+300', ml: 300 }, { l: '+500', ml: 500 }];
  await env.KV.put(key, JSON.stringify(u));
  return js({ ok: true, pending }, 200, cors);
}

async function hook(req, env) {
  if (env.SECRET && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRET) return new Response('no', { status: 403 });
  const up = await req.json();
  if (up.message && up.message.text && up.message.text.startsWith('/start')) {
    await tg(env, 'sendMessage', {
      chat_id: up.message.chat.id,
      text: 'Привет! Открой приложение кнопкой ниже. Напоминания о воде будут приходить сюда, а кнопками можно сразу записать выпитое.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: env.APP_URL } }]] },
    });
  }
  const q = up.callback_query;
  if (q) {
    const ml = parseInt(String(q.data || '').split(':')[1], 10);
    const key = 'u:' + q.from.id;
    const u = JSON.parse((await env.KV.get(key)) || 'null');
    if (u && ml > 0 && ml <= 2000) {
      const d = localDate(u.tz);
      if (u.date !== d) { u.date = d; u.total = 0; }
      u.total += ml;
      u.pending = (u.pending || []).concat([{ ml, d }]).slice(-200);
      await env.KV.put(key, JSON.stringify(u));
      await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: '+' + fmt(u, ml) });
      if (q.message) {
        await tg(env, 'editMessageText', {
          chat_id: q.message.chat.id, message_id: q.message.message_id,
          text: (u.lang === 'en' ? '✅ Logged. Today: ' : '✅ Записано. Сегодня: ') + fmt(u, u.total) + (u.lang === 'en' ? ' of ' : ' из ') + fmt(u, u.goal),
          reply_markup: kb(u),
        });
      }
    } else {
      await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Open the app once' });
    }
  }
  return new Response('ok');
}

async function tick(env) {
  let cursor;
  do {
    const l = await env.KV.list({ prefix: 'u:', cursor });
    for (const k of l.keys) {
      const u = JSON.parse((await env.KV.get(k.name)) || 'null');
      if (!u || !u.on) continue;
      const n = localNow(u.tz);
      const d = n.toISOString().slice(0, 10);
      const m = n.getUTCHours() * 60 + n.getUTCMinutes();
      let changed = false;
      if (u.date !== d) { u.date = d; u.total = 0; changed = true; }
      const due = m >= mins(u.from) && m <= mins(u.to) && u.total < u.goal &&
        Date.now() - (u.last || 0) >= u.every * 60000 - 300000;
      if (due) {
        const r = await tg(env, 'sendMessage', { chat_id: u.id, text: txt(u), reply_markup: kb(u) });
        u.last = Date.now();
        changed = true;
        if (r.status === 403) u.on = false; // пользователь заблокировал бота
      }
      if (changed) await env.KV.put(k.name, JSON.stringify(u));
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
}

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const p = new URL(req.url).pathname;
    if (p === '/sync' && req.method === 'POST') return sync(req, env, cors);
    if (p === '/webhook' && req.method === 'POST') return hook(req, env);
    return new Response('ok');
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(tick(env)); },
};
