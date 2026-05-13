/**
 * ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
 * │   TOXIC YOBBY KING - Deploy Version          │
 * │   Interactive setup: Session ID or Phone      │
 * ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

// ──────────────────────────────────────────────
// Main Setup
// ──────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╭━─━─━─━─━─━─━─━─━─━─━─━─━─━─━─━╮');
  console.log('│ ☠️  TOXIC YOBBY KING v6.0       │');
  console.log('│    Deploy Setup Wizard           │');
  console.log('╰━─━─━─━─━─━─━─━─━─━─━─━─━─━─━─━╯');
  console.log('');
  console.log('Choose an option:');
  console.log('  1️⃣  Enter Session ID (reconnect existing session)');
  console.log('  2️⃣  Enter Phone Number (request new pairing code)');
  console.log('');

  const choice = await question('Enter choice (1 or 2): ');
  console.log('');

  if (choice.trim() === '1') {
    await sessionFlow();
  } else if (choice.trim() === '2') {
    await phoneFlow();
  } else {
    console.log('❌ Invalid choice. Exiting.');
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// Session ID Flow
// ──────────────────────────────────────────────
async function sessionFlow() {
  const sessionId = await question('🔑 Enter your Session ID (e.g. toxicyobby-123456): ');
  
  if (!sessionId.trim().startsWith('toxicyobby-')) {
    console.log('❌ Invalid session ID format. Must start with "toxicyobby-"');
    process.exit(1);
  }

  // Check if session exists
  const sessionDir = path.join(__dirname, 'auth_info');
  const sessionFile = path.join(__dirname, 'database', 'sessions.json');
  
  let sessions = {};
  try {
    if (fs.existsSync(sessionFile)) {
      sessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    }
  } catch {}

  if (sessions[sessionId.trim()]) {
    const sessionData = sessions[sessionId.trim()];
    console.log('');
    console.log('╭━─━─━─━─━─━─━─━─━─━─━╮');
    console.log('│ ✅ Session Found!      │');
    console.log('│                        │');
    console.log(`│ Phone: ${sessionData.phone}`);
    console.log(`│ Status: ${sessionData.status}`);
    console.log('╰━─━─━─━─━─━─━─━─━─━─━╯');
    console.log('');
    console.log('🚀 Starting bot with existing session...');
    
    // Set environment variable for the bot
    process.env.SESSION_ID = sessionId.trim();
    startBot();
  } else {
    console.log('❌ Session ID not found. It may have expired.');
    console.log('Please pair again using option 2.');
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// Phone Number Flow
// ──────────────────────────────────────────────
async function phoneFlow() {
  const phone = await question('📱 Enter your WhatsApp phone number (e.g. 254712345678): ');
  
  if (!phone.trim() || phone.trim().length < 10) {
    console.log('❌ Invalid phone number.');
    process.exit(1);
  }

  let normalized = phone.trim().replace(/[\s\-+]/g, '');
  if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
  if (normalized.startsWith('7') || normalized.startsWith('1')) normalized = '254' + normalized;

  console.log('');
  console.log('╭━─━─━─━─━─━─━─━─━─━─━╮');
  console.log('│ 📱 Pairing Request    │');
  console.log(`│ Number: +${normalized}`);
  console.log('│ Status: Requesting... │');
  console.log('╰━─━─━─━─━─━─━─━─━─━─━╯');
  console.log('');
  console.log('🚀 Starting bot and requesting pairing code...');

  process.env.PAIR_PHONE = normalized;
  startBot();
}

// ──────────────────────────────────────────────
// Start Bot
// ──────────────────────────────────────────────
function startBot() {
  try {
    require('./index.js');
  } catch (err) {
    console.error('❌ Failed to start bot:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Setup error:', err.message);
  process.exit(1);
});
