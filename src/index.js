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
};

const app = express();
app.use(express.json({ limit: '1mb' }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const jobs = new Map();
let lastJobId = 0;

function okAuth(req, res) {
  const secret = req.headers['x-bridge-secret'] || req.query.secret || (req.body && req.body.secret);
  if (secret !== CONFIG.bridgeSecret) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

app.get('/', (_req, res) => {
  res.status(200).send('FAZE Discord Verify Bot ONLINE');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, pending: [...jobs.values()].filter(j => j.status === 'pending').length });
});

app.post('/bridge/job/next', (req, res) => {
  if (!okAuth(req, res)) return;
  const job = [...jobs.values()].find(j => j.status === 'pending');
  if (!job) return res.json({ ok: true, job: null });
  job.status = 'processing';
  job.lockedAt = Date.now();
  res.json({
    ok: true,
    job: {
      id: job.id,
      discordId: job.discordId,
      nickname: job.nickname,
      accountId: job.accountId,
      password: job.password,
    },
  });
});

app.post('/bridge/job/result', async (req, res) => {
  if (!okAuth(req, res)) return;
  const { id, ok, error, accountName, accountId } = req.body || {};
  const job = jobs.get(Number(id));
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });

  try {
    if (!ok) {
      job.status = 'failed';
      await job.interaction.editReply(`❌ Verificación fallida: ${error || 'datos incorrectos'}`);
      jobs.delete(job.id);
      return res.json({ ok: true });
    }

    const guild = await client.guilds.fetch(CONFIG.guildId);
    const member = await guild.members.fetch(job.discordId);
    const cleanName = String(accountName || job.nickname).replace(/[\n\r@#`]/g, '').slice(0, 24);
    const cleanId = String(accountId || job.accountId).replace(/[^0-9]/g, '').slice(0, 12);
    const newNick = `${cleanName} | ID ${cleanId}`.slice(0, 32);

    try { await member.setNickname(newNick, 'Verificación Santiago RP'); } catch (e) { console.log('[WARN] No se pudo cambiar nickname:', e.message); }
    try { await member.roles.add(CONFIG.ciudadanoRoleId, 'Verificación Santiago RP'); } catch (e) { console.log('[WARN] No se pudo dar rol ciudadano:', e.message); }

    job.status = 'done';
    await job.interaction.editReply(`✅ Verificación completada.\nTu nombre fue actualizado a: **${newNick}**`);
    jobs.delete(job.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[RESULT ERROR]', e);
    try { await job.interaction.editReply('❌ Ocurrió un error aplicando el rol/nickname. Revisa que el rol del bot esté por encima del rol Ciudadano.'); } catch {}
    jobs.delete(job.id);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

async function sendPanel() {
  const channel = await client.channels.fetch(CONFIG.verifyChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('Canal de verificación inválido');

  const embed = new EmbedBuilder()
    .setTitle('🔐 Verificación de Cuenta')
    .setDescription('Haz clic en el botón para verificar tu cuenta de **Santiago Roleplay**.\n\n📌 **Debes escribir:**\n• Nickname exacto del servidor\n• ID de tu cuenta\n• Contraseña de tu cuenta\n\n⚠️ Tu contraseña no se guarda en Discord. Solo se usa para verificar con el servidor.')
    .setColor(0x2ecc71)
    .setFooter({ text: 'Sistema de Verificación Faze' });

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

client.on(Events.InteractionCreate, async interaction => {
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

    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'faze_verify_modal') {
    const nickname = interaction.fields.getTextInputValue('nickname').trim();
    const accountId = interaction.fields.getTextInputValue('account_id').trim();
    const password = interaction.fields.getTextInputValue('password');

    if (!/^\d+$/.test(accountId)) {
      return interaction.reply({ ephemeral: true, content: '❌ El ID solo puede tener números.' });
    }

    await interaction.deferReply({ ephemeral: true });

    const id = ++lastJobId;
    jobs.set(id, {
      id,
      status: 'pending',
      discordId: interaction.user.id,
      nickname,
      accountId,
      password,
      interaction,
      createdAt: Date.now(),
    });

    await interaction.editReply('⏳ Verificando tu cuenta con el servidor MTA... espera unos segundos.');

    setTimeout(async () => {
      const job = jobs.get(id);
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        jobs.delete(id);
        try { await interaction.editReply('❌ La verificación tardó demasiado. Inténtalo de nuevo en unos segundos.'); } catch {}
      }
    }, 60000);
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

app.listen(CONFIG.port, () => {
  console.log(`[OK] HTTP bridge activo en puerto ${CONFIG.port}`);
});

client.login(CONFIG.token);
