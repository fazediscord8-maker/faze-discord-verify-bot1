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
  MessageFlags,
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
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 25000),
  retryProcessingAfterMs: Number(process.env.RETRY_PROCESSING_AFTER_MS || 2500),
};

const app = express();
app.use(express.json({ limit: '1mb' }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const jobs = new Map();
let lastJobId = 0;
let lastBridgeSeenAt = 0;

function normalizeBody(body) {
  // MTA toJSON can sometimes arrive wrapped as an array with one object.
  if (Array.isArray(body) && body.length === 1 && typeof body[0] === 'object') return body[0];
  return body || {};
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

  // If MTA took a job but result was lost, release it quickly instead of waiting 60s.
  for (const job of jobs.values()) {
    if (job.status === 'processing' && now - (job.lockedAt || 0) > CONFIG.retryProcessingAfterMs) {
      job.status = 'processing';
      job.lockedAt = now;
      job.attempts = (job.attempts || 0) + 1;
      console.log(`[RETRY] Reenviando job ${job.id}, attempts=${job.attempts}`);
      return job;
    }
  }

  return null;
}

async function applyVerified(job, accountName, accountId) {
  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(job.discordId);
  const cleanName = safeText(accountName || job.nickname, 24);
  const cleanId = String(accountId || job.accountId).replace(/[^0-9]/g, '').slice(0, 12);
  const newNick = `${cleanName} | ID ${cleanId}`.slice(0, 32);

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

  await job.interaction.editReply(`✅ Verificación completada.\nTu nombre fue actualizado a: **${newNick}**${nickWarn}${roleWarn}`);
}

async function failJob(job, message) {
  try {
    await job.interaction.editReply(`❌ Verificación fallida: ${message || 'datos incorrectos'}`);
  } catch (e) {
    console.log('[WARN] No se pudo editar respuesta de fallo:', e.message);
  }
}

app.get('/', (_req, res) => {
  res.status(200).send('FAZE Discord Verify Bot FAST ONLINE');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'FAST_QUEUE_V2',
    pending: countJobs('pending'),
    processing: countJobs('processing'),
    total: jobs.size,
    lastBridgeSeenAgo: msAgo(lastBridgeSeenAt),
  });
});

app.post('/bridge/ping', (req, res) => {
  if (!okAuth(req, res)) return;
  lastBridgeSeenAt = Date.now();
  res.json({ ok: true, mode: 'FAST_QUEUE_V2', now: Date.now() });
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

  // Respond to MTA immediately. Discord updates happen after, so MTA never waits long.
  res.json({ ok: true, received: true });

  const elapsed = Date.now() - job.createdAt;
  console.log(`[MTA->RESULT] id=${id} ok=${body.ok} elapsed=${elapsed}ms error=${body.error || ''}`);

  try {
    if (!body.ok) {
      await failJob(job, body.error || 'datos incorrectos');
      jobs.delete(id);
      return;
    }

    await applyVerified(job, body.accountName || job.nickname, body.accountId || job.accountId);
    jobs.delete(id);
  } catch (e) {
    console.error('[RESULT ERROR]', e);
    try { await job.interaction.editReply('❌ Ocurrió un error aplicando el rol/nickname. Revisa permisos y jerarquía del bot.'); } catch {}
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
    .setFooter({ text: 'Sistema de Verificación Faze • FAST V2' });

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

process.on('unhandledRejection', err => {
  console.error('[UNHANDLED REJECTION]', err);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

client.on(Events.Error, err => {
  console.error('[CLIENT ERROR]', err);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
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

    return await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'faze_verify_modal') {
    // Discord exige responder/acknowledge al modal en menos de 3 segundos.
    // Esto va primero para evitar DiscordAPIError[10062]: Unknown interaction.
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error('[INTERACTION ACK ERROR] No pude responder a tiempo el modal:', e?.message || e);
      return;
    }

    const nickname = interaction.fields.getTextInputValue('nickname').trim();
    const accountId = interaction.fields.getTextInputValue('account_id').trim();
    const password = interaction.fields.getTextInputValue('password');

    if (!/^\d+$/.test(accountId)) {
      return interaction.editReply('❌ El ID solo puede tener números.');
    }

    // Remove older pending jobs from the same Discord user to avoid conflicts.
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
    try {
      await interaction.editReply('⏳ Verificando tu cuenta con el servidor MTA... espera unos segundos.');
    } catch (e) {
      console.error('[INTERACTION EDIT ERROR] No pude enviar mensaje inicial:', e?.message || e);
    }

    setTimeout(async () => {
      const job = jobs.get(id);
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        jobs.delete(id);
        console.log(`[TIMEOUT] id=${id} waited=${Date.now() - job.createdAt}ms attempts=${job.attempts}`);
        try { await interaction.editReply('❌ La verificación tardó demasiado. Inténtalo otra vez en unos segundos.'); } catch {}
      }
    }, CONFIG.jobTimeoutMs);
  }
  } catch (e) {
    console.error('[INTERACTION ERROR]', e);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply('❌ Ocurrió un error interno procesando la verificación.');
      else await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Ocurrió un error interno procesando la verificación.' });
    } catch {}
  }
});

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
  console.log(`[STATUS] pending=${countJobs('pending')} processing=${countJobs('processing')} bridgeAgo=${msAgo(lastBridgeSeenAt)}`);
}, 60000);

app.listen(CONFIG.port, () => {
  console.log(`[OK] HTTP bridge FAST V2 activo en puerto ${CONFIG.port}`);
});

client.login(CONFIG.token);
