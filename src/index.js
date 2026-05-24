require('dotenv').config();

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  Events,
} = require('discord.js');

function need(name) {
  const value = process.env[name];
  if (!value || String(value).trim() === '') throw new Error(`Falta configurar ${name}`);
  return String(value).trim();
}

const CONFIG = {
  token: need('DISCORD_TOKEN'),
  guildId: need('GUILD_ID'),
  verifyChannelId: need('VERIFY_CHANNEL_ID'),
  ciudadanoRoleId: need('ROLE_CIUDADANO'),
  bridgeSecret: need('BRIDGE_SECRET'),
  port: Number(process.env.PORT || 10000),
  // V15: timeout seguro configurable. Default 120s; máximo 180s.
  // Si el bridge está conectado, la respuesta normal debe llegar en 1-10s.
  jobTimeoutMs: Math.min(Math.max(Number(process.env.JOB_TIMEOUT_MS || 120000), 30000), 180000),
  retryProcessingAfterMs: Number(process.env.RETRY_PROCESSING_AFTER_MS || 1200),
  maxAttempts: Number(process.env.MAX_JOB_ATTEMPTS || 60),
  verifyLogWebhookUrl: String(process.env.VERIFY_LOG_WEBHOOK_URL || 'https://discord.com/api/webhooks/1507213086048911611/qNJXc9kOqTiARrqmVjQapfG_j9bjlxX3NHaCvmDBA2URHVfaM_VnXdAsbYEzGdpPEdvy').trim(),

  // Discord -> Twister MTA
  twisterChannelId: String(process.env.TWISTER_CHANNEL_ID || '1483679844666576906').trim(),
  twisterEnabled: String(process.env.TWISTER_ENABLED || 'true').toLowerCase() !== 'false',
  twisterMaxBurst: Number(process.env.TWISTER_MAX_BURST || 5),
  twisterWindowMs: Number(process.env.TWISTER_WINDOW_MS || 5000),
  twisterMuteMs: Number(process.env.TWISTER_MUTE_MS || 15000),
};

const app = express();
// V5: acepta JSON normal, texto plano y form-urlencoded.
// MTA fetchRemote viejo puede mandar el body como texto aunque el contenido sea JSON.
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const jobs = new Map();
const twisterJobs = new Map();
const twisterFlood = new Map();
let lastJobId = 0;
let lastTwisterJobId = 0;
let lastBridgeSeenAt = 0;

function normalizeBody(body) {
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  if (Array.isArray(body) && body.length === 1 && typeof body[0] === 'object') return body[0];
  return body || {};
}

function isUnknownInteraction(err) {
  return err && (err.code === 10062 || err.rawError?.code === 10062 || String(err.message || '').includes('Unknown interaction'));
}

function logInteractionError(stage, err) {
  if (isUnknownInteraction(err)) {
    console.log(`[INTERACTION EXPIRED] ${stage}: Discord expiró la interacción antes de responder. No se cae el bot.`);
    return;
  }
  console.error(`[INTERACTION ERROR] ${stage}`, err);
}

function okAuth(req, res) {
  const body = normalizeBody(req.body);
  const secret = req.headers['x-bridge-secret'] || req.query.secret || body.secret;
  if (secret !== CONFIG.bridgeSecret) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

function safeText(v, max = 32) {
  return String(v || '').replace(/[\n\r@#`]/g, '').trim().slice(0, max);
}

function countJobs(status) {
  return [...jobs.values()].filter(j => j.status === status).length;
}

function msAgo(ts) {
  return ts ? `${Date.now() - ts}ms` : 'never';
}


function formatMoney(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'No disponible') return 'No disponible';
  const n = Number(String(raw).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return raw.slice(0, 64);
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function discordUserLabel(user) {
  if (!user) return 'No disponible';
  return `${user.tag || user.username || 'Usuario'} (${user.id})`;
}

async function sendVerifyWebhookLog(kind, payload) {
  if (!CONFIG.verifyLogWebhookUrl) return;

  const isSuccess = kind === 'success';
  const title = isSuccess ? '🔐 Nueva Verificación Discord ↔ MTA' : '❌ Verificación Fallida Discord ↔ MTA';
  const color = isSuccess ? 0x2ecc71 : 0xe74c3c;
  const now = new Date();

  const fields = isSuccess ? [
    { name: '👤 Usuario Discord', value: payload.discordLabel || 'No disponible', inline: false },
    { name: '🆔 Discord ID', value: String(payload.discordId || 'No disponible'), inline: true },
    { name: '🎮 Cuenta MTA', value: String(payload.accountName || 'No disponible'), inline: true },
    { name: '📋 ID Cuenta', value: String(payload.accountId || 'No disponible'), inline: true },
    { name: '💰 Dinero Cartera', value: formatMoney(payload.walletMoney), inline: true },
    { name: '🏦 Dinero Banco', value: formatMoney(payload.bankMoney), inline: true },
    { name: '🖥️ Serial Cuenta', value: String(payload.serial || 'No disponible').slice(0, 100), inline: false },
    { name: '🔗 Nickname Discord Aplicado', value: String(payload.nicknameApplied || 'No disponible').slice(0, 100), inline: false },
    { name: '✅ Estado', value: 'VERIFICACIÓN EXITOSA', inline: false },
  ] : [
    { name: '👤 Usuario Discord', value: payload.discordLabel || 'No disponible', inline: false },
    { name: '🆔 Discord ID', value: String(payload.discordId || 'No disponible'), inline: true },
    { name: '🏷️ Nickname elegido', value: String(payload.nickname || 'No disponible').slice(0, 64), inline: true },
    { name: '📋 ID introducido', value: String(payload.accountId || 'No disponible').slice(0, 32), inline: true },
    { name: '📌 Motivo', value: String(payload.reason || 'Datos incorrectos').slice(0, 200), inline: false },
    { name: '❌ Estado', value: 'VERIFICACIÓN FALLIDA', inline: false },
  ];

  const body = {
    username: 'Santiago RP Verify Logs',
    embeds: [{
      title,
      color,
      fields,
      footer: { text: 'Sistema de Verificación • Santiago Roleplay' },
      timestamp: now.toISOString(),
    }],
  };

  try {
    const resp = await fetch(CONFIG.verifyLogWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.log(`[WEBHOOK LOG WARN] status=${resp.status}`);
  } catch (e) {
    console.log('[WEBHOOK LOG ERROR]', e.message);
  }
}

function selectNextJob() {
  const now = Date.now();

  for (const job of jobs.values()) {
    if (job.status === 'pending') {
      job.status = 'processing';
      job.lockedAt = now;
      job.attempts = (job.attempts || 0) + 1;
      return job;
    }
  }

  for (const job of jobs.values()) {
    if (job.status === 'processing' && now - (job.lockedAt || 0) > CONFIG.retryProcessingAfterMs) {
      if ((job.attempts || 0) >= CONFIG.maxAttempts) {
        job.status = 'expired';
        continue;
      }
      job.lockedAt = now;
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts === 1 || job.attempts % 10 === 0) console.log(`[RETRY] Reenviando job ${job.id}, attempts=${job.attempts}`);
      return job;
    }
  }

  return null;
}

async function safeEditReply(interaction, content) {
  try {
    if (!interaction) return false;
    await interaction.editReply(content);
    return true;
  } catch (e) {
    logInteractionError('editReply', e);
    return false;
  }
}

async function applyVerified(job, accountName, accountId, serial, walletMoney, bankMoney) {
  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(job.discordId);
  const accountCleanName = safeText(accountName || job.nickname || 'Cuenta', 24);
  const cleanName = safeText(job.displayNickname || accountName || job.nickname, 24);
  const cleanId = String(accountId || job.accountId).replace(/[^0-9]/g, '').slice(0, 12);
  const newNick = `${cleanName} | ID ${cleanId}`.slice(0, 32);
  const cleanSerial = safeText(serial || job.serial || 'No disponible', 64);

  let nickWarn = '';
  let roleWarn = '';

  try {
    await member.setNickname(newNick, 'Verificación Santiago RP');
  } catch (e) {
    nickWarn = '\n⚠️ No pude cambiar el nickname. Sube el rol del bot por encima del usuario/rol.';
    console.log('[WARN] No se pudo cambiar nickname:', e.message);
  }

  try {
    await member.roles.add(CONFIG.ciudadanoRoleId, 'Verificación Santiago RP');
  } catch (e) {
    roleWarn = '\n⚠️ No pude dar el rol Ciudadano. Sube el rol del bot por encima de Ciudadano.';
    console.log('[WARN] No se pudo dar rol ciudadano:', e.message);
  }

  await safeEditReply(job.interaction, `✅ **Verificación completada.**\n👤 Cuenta: **${cleanName}**\n🆔 ID: **${cleanId}**\n🔐 Serial: **${cleanSerial}**\n🏷️ Nickname autorizado: **${newNick}**${nickWarn}${roleWarn}`);

  await sendVerifyWebhookLog('success', {
    discordLabel: discordUserLabel(member.user),
    discordId: job.discordId,
    accountName: accountCleanName,
    accountId: cleanId,
    serial: cleanSerial,
    walletMoney,
    bankMoney,
    nicknameApplied: newNick,
  });
}

async function failJob(job, message) {
  const reason = message || 'datos incorrectos';
  await safeEditReply(job.interaction, `❌ Verificación fallida: ${reason}`);
  await sendVerifyWebhookLog('failed', {
    discordLabel: discordUserLabel(job.interaction?.user),
    discordId: job.discordId,
    nickname: job.nickname,
    accountId: job.accountId,
    reason,
  });
}


function mergedInput(req) {
  const body = normalizeBody(req.body);
  return Object.assign({}, req.query || {}, body || {});
}

function bridgePingHandler(req, res) {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  res.json({ ok: true, mode: 'FAST_QUEUE_V15_STABLE_NO_DOUBLE_CLICK', now: Date.now() });
}

function bridgeNextHandler(req, res) {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  const job = selectNextJob();

  if (!job) {
    return res.json({ ok: true, job: null, pending: countJobs('pending'), processing: countJobs('processing') });
  }

  console.log(`[JOB->MTA] id=${job.id} discord=${job.discordId} nick=${job.nickname} accountId=${job.accountId} attempt=${job.attempts}`);
  return res.json({
    ok: true,
    job: {
      id: job.id,
      discordId: job.discordId,
      nickname: job.nickname,
      displayNickname: job.displayNickname,
      accountId: job.accountId,
      password: job.password,
      createdAt: job.createdAt,
    },
  });
}

async function bridgeResultHandler(req, res) {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  const body = mergedInput(req);
  const id = Number(body.id);
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ ok: false, error: 'job_not_found_or_expired' });
  }

  res.json({ ok: true, received: true });

  const elapsed = Date.now() - job.createdAt;
  console.log(`[MTA->RESULT] id=${id} ok=${body.ok} elapsed=${elapsed}ms error=${body.error || ''}`);

  try {
    const okValue = body.ok === true || body.ok === 'true' || body.ok === '1' || body.ok === 1;
    if (!okValue) {
      await failJob(job, body.error || 'datos incorrectos');
      jobs.delete(id);
      return;
    }

    await applyVerified(job, body.accountName || job.nickname, body.accountId || job.accountId, body.serial || body.accountSerial, body.walletMoney || body.money || body.cash, body.bankMoney || body.bank);
    jobs.delete(id);
  } catch (e) {
    console.error('[RESULT ERROR]', e);
    await safeEditReply(job.interaction, '❌ Ocurrió un error aplicando el rol/nickname. Revisa permisos y jerarquía del bot.');
    jobs.delete(id);
  }
}


function cleanTwisterText(v) {
  return String(v || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .trim()
    .slice(0, 180);
}

function isTwisterFlood(userId) {
  const now = Date.now();
  const item = twisterFlood.get(userId) || { times: [], mutedUntil: 0 };
  if (item.mutedUntil && now < item.mutedUntil) {
    twisterFlood.set(userId, item);
    return true;
  }
  item.times = (item.times || []).filter(t => now - t < CONFIG.twisterWindowMs);
  item.times.push(now);
  if (item.times.length > CONFIG.twisterMaxBurst) {
    item.mutedUntil = now + CONFIG.twisterMuteMs;
    item.times = [];
    twisterFlood.set(userId, item);
    return true;
  }
  twisterFlood.set(userId, item);
  return false;
}

function selectNextTwisterJob() {
  for (const job of twisterJobs.values()) {
    if (job.status === 'pending') {
      job.status = 'processing';
      job.lockedAt = Date.now();
      return job;
    }
  }
  return null;
}

function bridgeTwisterNextHandler(req, res) {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  const job = selectNextTwisterJob();
  if (!job) return res.json({ ok: true, job: null, pending: [...twisterJobs.values()].filter(j => j.status === 'pending').length });
  return res.json({
    ok: true,
    job: {
      id: job.id,
      discordId: job.discordId,
      discordTag: job.discordTag,
      displayName: job.displayName,
      text: job.text,
      createdAt: job.createdAt,
    },
  });
}

function bridgeTwisterResultHandler(req, res) {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  const body = mergedInput(req);
  const id = Number(body.id);
  if (id && twisterJobs.has(id)) twisterJobs.delete(id);
  res.json({ ok: true, received: true });
}


app.get('/', (_req, res) => {
  res.status(200).send('Santiago RP Verify Bot FAST V15 ONLINE');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'FAST_QUEUE_V15_STABLE_NO_DOUBLE_CLICK',
    pending: countJobs('pending'),
    processing: countJobs('processing'),
    total: jobs.size,
    lastBridgeSeenAgo: msAgo(lastBridgeSeenAt),
  });
});

app.get('/bridge/ping', bridgePingHandler);
app.post('/bridge/ping', bridgePingHandler);
app.get('/bridge/job/next', bridgeNextHandler);
app.post('/bridge/job/next', bridgeNextHandler);
app.get('/bridge/job/result', bridgeResultHandler);
app.post('/bridge/job/result', bridgeResultHandler);
app.get('/bridge/twister/next', bridgeTwisterNextHandler);
app.post('/bridge/twister/next', bridgeTwisterNextHandler);
app.get('/bridge/twister/result', bridgeTwisterResultHandler);
app.post('/bridge/twister/result', bridgeTwisterResultHandler);

async function sendPanel() {
  const channel = await client.channels.fetch(CONFIG.verifyChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('Canal de verificación inválido');

  const embed = new EmbedBuilder()
    .setTitle('🔐 Verificación de Cuenta')
    .setDescription('Haz clic en el botón para verificar tu cuenta de **Santiago Roleplay**.\n\n📌 **Debes escribir:**\n• ID de tu cuenta\n• Contraseña de tu cuenta\n• Nickname que quieres usar en Discord\n\n⚠️ Tu contraseña no se guarda en Discord. Solo se usa para verificar con el servidor.')
    .setColor(0x2ecc71)
    .setFooter({ text: 'Sistema de Verificación • Santiago Roleplay' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('faze_verify_open')
      .setLabel('Verificar Cuenta')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );

  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  const old = recent ? recent.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === '🔐 Verificación de Cuenta') : null;
  if (old) await old.edit({ embeds: [embed], components: [row] });
  else await channel.send({ embeds: [embed], components: [row] });
}

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === 'faze_verify_open') {
    const modal = new ModalBuilder()
      .setCustomId('faze_verify_modal')
      .setTitle('🔐 Verificación de Cuenta');

    const nickname = new TextInputBuilder()
      .setCustomId('nickname')
      .setLabel('Nickname para Discord (será permanente)')
      .setPlaceholder('Ej: Faze')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(32)
      .setRequired(false);

    const accountId = new TextInputBuilder()
      .setCustomId('account_id')
      .setLabel('ID de tu cuenta en el servidor')
      .setPlaceholder('Ej: 4')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(12)
      .setRequired(true);

    const password = new TextInputBuilder()
      .setCustomId('password')
      .setLabel('Contraseña de tu cuenta')
      .setPlaceholder('Tu contraseña del juego')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(128)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nickname),
      new ActionRowBuilder().addComponents(accountId),
      new ActionRowBuilder().addComponents(password)
    );

    try {
      await interaction.showModal(modal);
    } catch (e) {
      logInteractionError('showModal', e);
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'faze_verify_modal') {
    const nickname = interaction.fields.getTextInputValue('nickname').trim() || interaction.user.username;
    const accountId = interaction.fields.getTextInputValue('account_id').trim();
    const password = interaction.fields.getTextInputValue('password');

    if (!/^\d+$/.test(accountId)) {
      try {
        await interaction.reply({ flags: 64, content: '❌ El ID solo puede tener números.' });
      } catch (e) {
        logInteractionError('reply invalid id', e);
      }
      return;
    }

    try {
      await interaction.deferReply({ flags: 64 });
    } catch (e) {
      logInteractionError('deferReply modal', e);
      return;
    }

    for (const [jid, old] of jobs.entries()) {
      if (old.discordId === interaction.user.id && (old.status === 'pending' || old.status === 'processing')) {
        old.status = 'cancelled';
        jobs.delete(jid);
        // Evita mensajes viejos quedándose eternamente en "pensando" si el usuario reintenta.
        safeEditReply(old.interaction, '⚠️ Esta verificación fue reemplazada por un nuevo intento. Revisa el mensaje más reciente.');
      }
    }

    const id = ++lastJobId;
    jobs.set(id, {
      id,
      status: 'pending',
      discordId: interaction.user.id,
      nickname: '',
      displayNickname: nickname,
      accountId,
      password,
      interaction,
      attempts: 0,
      createdAt: Date.now(),
      lockedAt: 0,
    });

    console.log(`[DISCORD->JOB] id=${id} user=${interaction.user.id} displayNick=${nickname} accountId=${accountId}`);
    // V15: no mensaje intermedio. Solo resultado final o corte seguro configurable.

    setTimeout(async () => {
      const job = jobs.get(id);
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        jobs.delete(id);
        const seconds = Math.round(CONFIG.jobTimeoutMs / 1000);
        console.log(`[TIMEOUT] id=${id} waited=${Date.now() - job.createdAt}ms attempts=${job.attempts} bridgeAgo=${msAgo(lastBridgeSeenAt)} timeout=${CONFIG.jobTimeoutMs}ms`);
        await safeEditReply(interaction, `❌ La verificación no recibió respuesta del servidor MTA después de ${seconds} segundos.\nNo vuelvas a intentarlo varias veces: avisa a staff para revisar la conexión de verificación.`);
      }
    }, CONFIG.jobTimeoutMs);
  }
}

client.on(Events.InteractionCreate, interaction => {
  handleInteraction(interaction).catch(e => logInteractionError('InteractionCreate wrapper', e));
});


client.on(Events.MessageCreate, async (message) => {
  try {
    if (!CONFIG.twisterEnabled) return;
    if (!message.guild || message.author?.bot) return;
    if (message.channel.id !== CONFIG.twisterChannelId) return;

    const content = cleanTwisterText(message.content);
    if (!content) return;

    if (isTwisterFlood(message.author.id)) {
      // Protección anti-flood: se ignora temporalmente en vez de spamear Discord/MTA.
      return;
    }

    const memberName = message.member?.displayName || message.author.username || 'Discord';
    const id = ++lastTwisterJobId;
    twisterJobs.set(id, {
      id,
      status: 'pending',
      discordId: message.author.id,
      discordTag: message.author.tag || message.author.username,
      displayName: cleanTwisterText(memberName).slice(0, 32),
      text: content,
      createdAt: Date.now(),
      lockedAt: 0,
    });

    console.log(`[DISCORD->TWISTER] id=${id} user=${message.author.id} text=${content.slice(0, 80)}`);
  } catch (e) {
    console.error('[TWISTER MESSAGE ERROR]', e);
  }
});


client.on('error', e => console.error('[CLIENT ERROR]', e));
client.on('shardError', e => console.error('[SHARD ERROR]', e));
process.on('unhandledRejection', e => console.error('[UNHANDLED REJECTION - NO CRASH]', e));
process.on('uncaughtException', e => console.error('[UNCAUGHT EXCEPTION - NO CRASH]', e));

client.once(Events.ClientReady, async () => {
  console.log(`[OK] Bot conectado como ${client.user.tag}`);
  try {
    await sendPanel();
    console.log('[OK] Panel de verificación enviado/actualizado');
  } catch (e) {
    console.error('[PANEL ERROR]', e);
  }
});

setInterval(() => {
  console.log(`[STATUS] pending=${countJobs('pending')} processing=${countJobs('processing')} bridgeAgo=${msAgo(lastBridgeSeenAt)} timeout=${CONFIG.jobTimeoutMs}ms`);
}, 60000);
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > CONFIG.jobTimeoutMs + 15000) jobs.delete(id);
  }
  for (const [id, job] of twisterJobs.entries()) {
    if (now - job.createdAt > 60000) twisterJobs.delete(id);
  }
}, 30000);


app.listen(CONFIG.port, () => {
  console.log(`[OK] HTTP bridge FAST V15 activo en puerto ${CONFIG.port}`);
});

client.login(CONFIG.token);
