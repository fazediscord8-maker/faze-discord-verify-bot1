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
  // V9: nunca usar timeouts cortos. Discord permite editar un deferReply por varios minutos.
  // Si Render/MTA tarda unos segundos por carga o cold start, no mostramos falso error al usuario.
  jobTimeoutMs: Math.max(Number(process.env.JOB_TIMEOUT_MS || 120000), 120000),
  retryProcessingAfterMs: Number(process.env.RETRY_PROCESSING_AFTER_MS || 1200),
  maxAttempts: Number(process.env.MAX_JOB_ATTEMPTS || 60),
};

const app = express();
// V5: acepta JSON normal, texto plano y form-urlencoded.
// MTA fetchRemote viejo puede mandar el body como texto aunque el contenido sea JSON.
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const jobs = new Map();
let lastJobId = 0;
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

async function applyVerified(job, accountName, accountId, serial) {
  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(job.discordId);
  const cleanName = safeText(accountName || job.nickname, 24);
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
}

async function failJob(job, message) {
  await safeEditReply(job.interaction, `❌ Verificación fallida: ${message || 'datos incorrectos'}`);
}

app.get('/', (_req, res) => {
  res.status(200).send('Santiago RP Verify Bot FAST V9 ONLINE');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'FAST_QUEUE_V9_STABLE_NO_FALSE_TIMEOUT',
    pending: countJobs('pending'),
    processing: countJobs('processing'),
    total: jobs.size,
    lastBridgeSeenAgo: msAgo(lastBridgeSeenAt),
  });
});

app.post('/bridge/ping', (req, res) => {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  res.json({ ok: true, mode: 'FAST_QUEUE_V9_STABLE_NO_FALSE_TIMEOUT', now: Date.now() });
});

app.post('/bridge/job/next', (req, res) => {
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
      accountId: job.accountId,
      password: job.password,
      createdAt: job.createdAt,
    },
  });
});

app.post('/bridge/job/result', async (req, res) => {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  const body = normalizeBody(req.body);
  const id = Number(body.id);
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ ok: false, error: 'job_not_found_or_expired' });
  }

  res.json({ ok: true, received: true });

  const elapsed = Date.now() - job.createdAt;
  console.log(`[MTA->RESULT] id=${id} ok=${body.ok} elapsed=${elapsed}ms error=${body.error || ''}`);

  try {
    if (!body.ok) {
      await failJob(job, body.error || 'datos incorrectos');
      jobs.delete(id);
      return;
    }

    await applyVerified(job, body.accountName || job.nickname, body.accountId || job.accountId, body.serial || body.accountSerial);
    jobs.delete(id);
  } catch (e) {
    console.error('[RESULT ERROR]', e);
    await safeEditReply(job.interaction, '❌ Ocurrió un error aplicando el rol/nickname. Revisa permisos y jerarquía del bot.');
    jobs.delete(id);
  }
});

async function sendPanel() {
  const channel = await client.channels.fetch(CONFIG.verifyChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('Canal de verificación inválido');

  const embed = new EmbedBuilder()
    .setTitle('🔐 Verificación de Cuenta')
    .setDescription('Haz clic en el botón para verificar tu cuenta de **Santiago Roleplay**.\n\n📌 **Debes escribir:**\n• Nickname exacto del servidor\n• ID de tu cuenta\n• Contraseña de tu cuenta\n\n⚠️ Tu contraseña no se guarda en Discord. Solo se usa para verificar con el servidor.')
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
      .setLabel('Nickname exacto del servidor')
      .setPlaceholder('Ej: Faze')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(32)
      .setRequired(true);

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
    const nickname = interaction.fields.getTextInputValue('nickname').trim();
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
        jobs.delete(jid);
      }
    }

    const id = ++lastJobId;
    jobs.set(id, {
      id,
      status: 'pending',
      discordId: interaction.user.id,
      nickname,
      accountId,
      password,
      interaction,
      attempts: 0,
      createdAt: Date.now(),
      lockedAt: 0,
    });

    console.log(`[DISCORD->JOB] id=${id} user=${interaction.user.id} nick=${nickname} accountId=${accountId}`);
    // V9: no enviamos mensaje intermedio de 'verificando'. Discord deja el panel cargando
    // hasta que llegue el resultado real, evitando confundir al usuario con un falso error.

    setTimeout(async () => {
      const job = jobs.get(id);
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        jobs.delete(id);
        console.log(`[TIMEOUT] id=${id} waited=${Date.now() - job.createdAt}ms attempts=${job.attempts} bridgeAgo=${msAgo(lastBridgeSeenAt)} timeout=${CONFIG.jobTimeoutMs}ms`);
        const bridgeMsg = lastBridgeSeenAt ? '' : '\n⚠️ El bridge MTA no ha conectado con Render todavía. Revisa config.lua, BRIDGE_SECRET y que el recurso esté iniciado.';
        await safeEditReply(interaction, `❌ La verificación no recibió respuesta del servidor MTA después de 120 segundos.${bridgeMsg}\nNo vuelvas a intentarlo varias veces: avisa a staff para revisar el bridge.`);
      }
    }, CONFIG.jobTimeoutMs);
  }
}

client.on(Events.InteractionCreate, interaction => {
  handleInteraction(interaction).catch(e => logInteractionError('InteractionCreate wrapper', e));
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

app.listen(CONFIG.port, () => {
  console.log(`[OK] HTTP bridge FAST V9 activo en puerto ${CONFIG.port}`);
});

client.login(CONFIG.token);
