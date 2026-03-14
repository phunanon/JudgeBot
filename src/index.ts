import * as D from 'discord.js';
import { AttachmentModerationStatus, Prisma, Punishment } from '@prisma/client';

import { generateJudgement, moderateAttachment } from './ai.js';
import { buildCleanupRow, handleCleanup } from './cleanup.js';
import { config } from './config.js';
import { prisma } from './db.js';

const commandData = [
  new D.SlashCommandBuilder()
    .setName('cases-here')
    .setDescription(
      'Set this channel as the case review channel for this server.',
    )
    .setContexts([D.InteractionContextType.Guild]),
  new D.ContextMenuCommandBuilder()
    .setName('Use as evidence')
    .setType(D.ApplicationCommandType.Message)
    .setContexts([D.InteractionContextType.Guild]),
].map(command => command.toJSON());

const caseWithEvidenceArgs = Prisma.validator<Prisma.CaseDefaultArgs>()({
  include: {
    evidence: {
      include: { attachments: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ channelSf: 'asc' }, { messageCreatedAt: 'asc' }],
    },
    judgement: true,
  },
});

type CaseWithEvidence = Prisma.CaseGetPayload<typeof caseWithEvidenceArgs>;
type ActionablePunishment = Exclude<Punishment, 'NONE'>;

type CollectedEvidenceMessage = {
  messageSf: string;
  channelSf: string;
  messageUrl: string;
  authorSf: string;
  collectorSf: string;
  content: string;
  hadAttachments: boolean;
  replySummary: string | null;
  messageCreatedAt: Date;
};

const punishmentLabels: Record<Punishment, string> = {
  BAN: 'Ban',
  KICK: 'Kick',
  MUTE: 'Mute',
  NONE: 'None',
};

const activeJudgements = new Set<number>();

const client = new D.Client({
  allowedMentions: { parse: [] },
  intents: [D.GatewayIntentBits.Guilds, D.GatewayIntentBits.GuildMembers],
});

client.once(D.Events.ClientReady, async readyClient => {
  await readyClient.application.commands.set(commandData);
  console.log(`JudgeBot is online as ${readyClient.user.tag}`);
});

client.on(D.Events.InteractionCreate, async interaction => {
  try {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'cases-here'
    ) {
      await handleCasesHere(interaction);
      return;
    }

    if (
      interaction.isMessageContextMenuCommand() &&
      interaction.commandName === 'Use as evidence'
    ) {
      await handleUseAsEvidence(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    console.error(error);

    const message = 'Something went wrong while handling that action.';

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: message, flags: [D.MessageFlags.Ephemeral] })
          .catch(e => console.error(e));
      } else {
        await interaction
          .reply({ content: message, flags: [D.MessageFlags.Ephemeral] })
          .catch(e => console.error(e));
      }
    }
  }
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  client.destroy();
  process.exit(0);
});

await client.login(config.discordToken);

async function handleCasesHere(
  interaction: D.ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: [D.MessageFlags.Ephemeral] });
  const { guild, channel } = interaction;
  if (!guild || !channel) {
    await interaction.editReply(
      'This command can only be used inside a server channel.',
    );
    return;
  }

  if (!channel.isTextBased() || channel.isDMBased()) {
    await interaction.editReply(
      'This channel cannot be used as a cases channel.',
    );
    return;
  }

  const actor = await guild.members.fetch(interaction.user.id);
  const botMember = await guild.members.fetchMe();

  if (!memberOutranksBot(actor, botMember, guild.ownerId)) {
    await interaction.editReply(
      'Only members with a higher server position than the bot can set the cases channel.',
    );
    return;
  }

  await getOrCreateGuildRecord(guild.id, channel.id);

  await interaction.editReply(`Cases channel now configured.`);
}

async function handleUseAsEvidence(
  interaction: D.MessageContextMenuCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: [D.MessageFlags.Ephemeral] });
  const { guild } = interaction;
  if (!guild) {
    await interaction.editReply(
      'Evidence can only be recorded inside a server.',
    );
    return;
  }

  const casesChannel = await getGuildChannel(guild);

  if (!casesChannel) {
    await interaction.editReply(
      'Evidence cannot be submitted until a cases channel is configured. Run /cases-here first.',
    );
    return;
  }

  const guildRecord = await getOrCreateGuildRecord(guild.id);

  const targetMessage = interaction.targetMessage;
  const botMember = await guild.members.fetchMe();

  if (targetMessage.author.bot) {
    await interaction.editReply('Bots cannot have cases opened against them.');
    return;
  }

  const targetMember = await guild.members
    .fetch(targetMessage.author.id)
    .catch(e => {
      console.error(e);
      return null;
    });

  if (!targetMember) {
    await interaction.editReply(
      'The author of that message is not available in the server.',
    );
    return;
  }

  if (memberOutranksBot(targetMember, botMember, guild.ownerId)) {
    await interaction.editReply(
      'This member is more senior than this bot - cases cannot be opened against them.',
    );
    return;
  }

  const { openCase, createdNewCase } = await (async () => {
    const existingOpenCase = await prisma.case.findFirst({
      where: {
        guildId: guildRecord.id,
        subjectSf: targetMessage.author.id,
        judgement: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingOpenCase) {
      return { openCase: existingOpenCase, createdNewCase: false };
    }

    const openCase = await createOpenCase(
      guild,
      guildRecord.id,
      targetMessage.author.id,
    );
    return { openCase, createdNewCase: true };
  })();

  const evidenceMessages = await collectEvidenceMessages(
    targetMessage,
    interaction.user.id,
  );
  const messageSfs = evidenceMessages.map(message => message.messageSf);

  const overlappingEvidence = await prisma.evidence.findMany({
    where: {
      caseId: openCase.id,
      messageSf: { in: messageSfs },
    },
    include: {
      attachments: { select: { url: true } },
    },
  });

  const existingMessageIds = new Set(
    overlappingEvidence.map(message => message.messageSf),
  );
  const targetEvidence = overlappingEvidence.find(
    evidence => evidence.messageSf === targetMessage.id,
  );
  const existingAttachmentUrls = new Set(
    targetEvidence?.attachments.map(attachment => attachment.url) ?? [],
  );
  const newEvidenceMessages = evidenceMessages.filter(
    message => !existingMessageIds.has(message.messageSf),
  );
  const newAttachments = [...targetMessage.attachments.values()].filter(
    attachment => !existingAttachmentUrls.has(attachment.url),
  );

  const writes = [
    ...newEvidenceMessages.map(message => {
      const attachments =
        message.messageSf === targetMessage.id
          ? newAttachments.map(attachment => ({ url: attachment.url }))
          : [];

      return prisma.evidence.create({
        data: {
          caseId: openCase.id,
          ...message,
          ...(attachments.length > 0
            ? { attachments: { create: attachments } }
            : {}),
        },
      });
    }),
    ...(targetEvidence && newAttachments.length > 0
      ? [
          prisma.evidence.update({
            where: { id: targetEvidence.id },
            data: {
              attachments: {
                create: newAttachments.map(attachment => ({
                  url: attachment.url,
                })),
              },
            },
          }),
        ]
      : []),
  ];

  if (writes.length > 0) {
    await prisma.$transaction(writes);
  }

  if (
    overlappingEvidence.length > 0 &&
    newEvidenceMessages.length === 0 &&
    newAttachments.length === 0
  ) {
    await interaction.editReply(
      `That message is already fully captured in case #${openCase.id}: ${openCase.caseMessageUrl}`,
    );
    return;
  }

  const newCase = createdNewCase ? ' (new)' : '';
  const newContextCount = newEvidenceMessages.length;
  const content =
    overlappingEvidence.length > 0
      ? `Added ${newContextCount} new contextual message(s) in case #${openCase.id}${newCase}: ${openCase.caseMessageUrl}`
      : `Saved as evidence against <@${targetMessage.author.id}> in case #${openCase.id}${newCase}: ${openCase.caseMessageUrl}`;
  await interaction.editReply(content);
}

async function handleButton(interaction: D.ButtonInteraction): Promise<void> {
  const [scope, action, caseIdValue] = interaction.customId.split(':');

  if (scope !== 'case' || !action || !caseIdValue) {
    await interaction.reply({
      content: 'That button payload is invalid.',
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  const caseId = Number(caseIdValue);

  if (!Number.isInteger(caseId)) {
    await interaction.reply({
      content: 'That case reference is invalid.',
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  if (action === 'view') {
    await handleViewEvidence(interaction, caseId);
    return;
  }

  if (action === 'judge') {
    await handleMakeJudgement(interaction, caseId);
    return;
  }

  if (action === 'prosecute') {
    await handleProsecute(interaction, caseId);
    return;
  }

  if (action === 'cleanup') {
    await handleCleanup(interaction, caseId);
    return;
  }

  await interaction.reply({
    content: 'That button action is not supported.',
    flags: [D.MessageFlags.Ephemeral],
  });
}

async function handleViewEvidence(
  interaction: D.ButtonInteraction,
  caseId: number,
): Promise<void> {
  const caseRecord = await getCaseWithEvidence(caseId);

  if (!caseRecord) {
    await interaction.reply({
      content: 'That case could not be found.',
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.reply({
    content: buildEvidenceList(caseRecord, true, 1800),
    components: [buildJudgeRow(caseRecord.id)],
    flags: [D.MessageFlags.Ephemeral],
  });
}

async function handleMakeJudgement(
  interaction: D.ButtonInteraction,
  caseId: number,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: 'Judgements can only run inside a server.',
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  if (activeJudgements.has(caseId)) {
    await interaction.reply({
      content: `A judgement is already in progress for case #${caseId}.`,
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  activeJudgements.add(caseId);

  try {
    await interaction.deferReply({ flags: [D.MessageFlags.Ephemeral] });

    const unmoderatedCase = await getCaseWithEvidence(caseId);

    if (!unmoderatedCase) {
      await interaction.editReply('That case could not be found.');
      return;
    }

    if (unmoderatedCase.judgement) {
      await interaction.editReply(
        `Case #${unmoderatedCase.id} already has a judgement: ${unmoderatedCase.judgement.messageUrl}`,
      );
      return;
    }

    for (const evidence of unmoderatedCase.evidence) {
      for (const attachment of evidence.attachments) {
        const moderation = await moderateAttachment(attachment.url);

        await prisma.evidenceAttachment.update({
          where: { id: attachment.id },
          data: {
            moderationStatus:
              moderation.status === 'CLEAN'
                ? AttachmentModerationStatus.CLEAN
                : AttachmentModerationStatus.IMPROPER,
            moderationRaw: moderation.raw,
          },
        });
      }
    }

    const dbCase = await getCaseWithEvidence(caseId);

    if (!dbCase) {
      await interaction.editReply(
        'The case disappeared before the judgement could be saved.',
      );
      return;
    }

    if (dbCase.judgement) {
      await interaction.editReply(
        `Case #${dbCase.id} already has a judgement: ${dbCase.judgement.messageUrl}`,
      );
      return;
    }

    const judgement = await generateJudgement(buildEvidenceList(dbCase, false));

    const channel = await getGuildChannel(interaction.guild);

    if (!channel) {
      await interaction.editReply(
        'No valid cases channel is configured. Set one with /cases-here.',
      );
      return;
    }

    const punishment =
      judgement.punishment === 'NONE'
        ? 'No action recommended'
        : judgement.punishment;
    const content = `:judge: ${punishment}
**Judgement for case #${dbCase.id} against <@${dbCase.subjectSf}>** ${dbCase.caseMessageUrl}
> ${judgement.summary}`;
    const components =
      judgement.punishment !== Punishment.NONE
        ? [buildProsecuteRow(dbCase.id, judgement.punishment)]
        : [];
    const judgementMessage = await channel.send({ content, components });

    await prisma.judgement.create({
      data: {
        caseId: dbCase.id,
        messageUrl: judgementMessage.url,
        summary: judgement.summary,
        punishment: judgement.punishment,
        judgedAt: new Date(),
      },
    });

    await interaction.editReply(
      `Case #${dbCase.id} closed: ${judgementMessage.url}`,
    );
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const channel = await getGuildChannel(interaction.guild);

    if (channel) {
      await channel
        .send({
          content: [
            `Judgement generation failed for case #${caseId}.`,
            `Error: ${errorMessage}`,
          ].join('\n'),
        })
        .catch(e => console.error(e));
    }

    await interaction.editReply(
      channel
        ? `Judgement failed for case #${caseId}. The error was posted to the channel.`
        : `Judgement failed for case #${caseId}.`,
    );
    console.error(error);
  } finally {
    activeJudgements.delete(caseId);
  }
}

async function handleProsecute(
  interaction: D.ButtonInteraction,
  caseId: number,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: 'Prosecution can only happen inside a server.',
      flags: [D.MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [D.MessageFlags.Ephemeral] });

  const actor = await interaction.guild.members.fetch(interaction.user.id);
  const botMember = await interaction.guild.members.fetchMe();

  if (!memberOutranksBot(actor, botMember, interaction.guild.ownerId)) {
    await interaction.editReply(
      'Only members with a higher server position than the bot can prosecute a case.',
    );
    return;
  }

  const caseRecord = await prisma.case.findUnique({
    where: {
      id: caseId,
    },
    include: {
      judgement: true,
    },
  });

  if (!caseRecord) {
    await interaction.editReply('That case could not be found.');
    return;
  }

  if (
    !caseRecord.judgement ||
    caseRecord.judgement.punishment === Punishment.NONE
  ) {
    await interaction.editReply(
      'This case does not currently recommend a prosecution action.',
    );
    return;
  }

  const punishment = caseRecord.judgement.punishment;
  const casesChannel = await getGuildChannel(interaction.guild);

  const reason = `JudgeBot case #${caseRecord.id}: ${caseRecord.judgement.summary}`;

  if (punishment === Punishment.BAN) {
    // await interaction.guild.members.ban(caseRecord.subjectSnowflakeId, {
    //   reason,
    // });
    console.log('I would have banned', caseRecord.subjectSf, reason);
  } else {
    const targetMember = await interaction.guild.members
      .fetch(caseRecord.subjectSf)
      .catch(e => console.error(e));

    if (!targetMember) {
      await interaction.editReply(
        'The target user is not available in the server for that action.',
      );
      return;
    }

    if (punishment === Punishment.KICK) {
      // await targetMember.kick(reason);
      console.log('I would have kicked', caseRecord.subjectSf, reason);
    } else {
      await targetMember.timeout(8 * 60 * 60_000, reason);
    }
  }

  await interaction.message
    .edit({ components: [buildCleanupRow(caseRecord.id)] })
    .catch(e => console.error(e));

  if (casesChannel) {
    await casesChannel
      .send(
        `${caseRecord.judgement.messageUrl} prosecuted by <@${interaction.user.id}>`,
      )
      .catch(e => console.error(e));
  }

  await interaction.editReply(`<@${caseRecord.subjectSf}> prosecuted`);
}

async function createOpenCase(
  guild: D.Guild,
  guildId: number,
  subjectSf: string,
) {
  const channel = await getGuildChannel(guild);

  if (!channel) {
    throw new Error(
      'No valid cases channel is configured. Set one with /cases-here.',
    );
  }

  const caseMessage = await channel.send({
    content: `Opening case against <@${subjectSf}>...`,
  });

  const openCase = await prisma.case.create({
    data: {
      guild: { connect: { id: guildId } },
      subjectSf,
      caseMessageUrl: caseMessage.url,
    },
  });

  await caseMessage.edit({
    content: `Case #${openCase.id} opened against <@${openCase.subjectSf}>`,
    components: [buildViewEvidenceRow(openCase.id)],
  });

  return openCase;
}

async function getGuildChannel(
  guild: D.Guild,
): Promise<D.GuildTextBasedChannel | null> {
  const guildConfig = await prisma.guild.findUnique({
    where: { sf: guild.id },
  });

  if (!guildConfig?.casesChannelSf) {
    return null;
  }

  const channel = await guild.channels
    .fetch(guildConfig.casesChannelSf)
    .catch(e => console.error(e));

  if (!isGuildTextChannel(channel)) {
    return null;
  }

  return channel;
}

async function getOrCreateGuildRecord(sf: string, casesChannelSf?: string) {
  return prisma.guild.upsert({
    where: { sf },
    update: casesChannelSf ? { casesChannelSf } : {},
    create: { sf, casesChannelSf },
  });
}

async function getCaseWithEvidence(
  caseId: number,
): Promise<CaseWithEvidence | null> {
  const caseRecord = await prisma.case.findUnique({
    where: { id: caseId },
    ...caseWithEvidenceArgs,
  });

  caseRecord?.evidence.sort((left, right) => {
    const channelDifference = left.channelSf.localeCompare(right.channelSf);

    if (channelDifference !== 0) {
      return channelDifference;
    }

    const createdAtDifference =
      left.messageCreatedAt.getTime() - right.messageCreatedAt.getTime();

    if (createdAtDifference !== 0) {
      return createdAtDifference;
    }

    return left.messageSf.localeCompare(right.messageSf);
  });

  return caseRecord;
}

async function collectEvidenceMessages(
  targetMessage: D.Message,
  collectorSf: string,
): Promise<CollectedEvidenceMessage[]> {
  const priorMessages =
    targetMessage.channel.isTextBased() && 'messages' in targetMessage.channel
      ? await targetMessage.channel.messages
          .fetch({ before: targetMessage.id, limit: 5 })
          .catch(e => {
            console.error(e);
            return null;
          })
      : null;

  const contextMessages = [
    ...(priorMessages ? [...priorMessages.values()].reverse() : []),
    targetMessage,
  ];

  return Promise.all(
    contextMessages.map(async message => {
      return {
        messageSf: message.id,
        channelSf: message.channelId,
        messageUrl: message.url,
        authorSf: message.author.id,
        collectorSf,
        content: truncateEvidenceMessage(
          stringOrFallback(message.content, '*No text content*'),
        ),
        hadAttachments: message.attachments.size > 0,
        replySummary: await getReplyContext(message),
        messageCreatedAt: message.createdAt,
      };
    }),
  );
}

async function getReplyContext(message: D.Message): Promise<string | null> {
  const referencedMessageId = message.reference?.messageId;

  if (!referencedMessageId) {
    return null;
  }

  const referencedMessage =
    message.channel.isTextBased() && 'messages' in message.channel
      ? await message.channel.messages.fetch(referencedMessageId).catch(e => {
          console.error(e);
          return null;
        })
      : null;

  if (!referencedMessage) {
    return 'another message';
  }

  return `"${truncate(stringOrFallback(referencedMessage.content, '*No text content*'), 80)}"`;
}

function buildEvidenceList(
  caseRecord: CaseWithEvidence,
  withMetadata: boolean,
  maxLength = 8_000,
): string {
  const lines: string[] = [];

  if (withMetadata) {
    const collectors = [
      ...new Set(caseRecord.evidence.map(evidence => evidence.collectorSf)),
    ];

    if (collectors.length > 0) {
      lines.push(`Collected by ${collectors.map(sf => `<@${sf}>`).join(', ')}`);
    }
  }

  lines.push('```');

  const exhibitGroups = [
    ...groupEvidenceByChannel(caseRecord.evidence).values(),
  ]
    .sort((left, right) => {
      const leftFirst = left[0];
      const rightFirst = right[0];

      if (!leftFirst || !rightFirst) {
        return 0;
      }

      const createdAtDifference =
        leftFirst.messageCreatedAt.getTime() -
        rightFirst.messageCreatedAt.getTime();

      if (createdAtDifference !== 0) {
        return createdAtDifference;
      }

      return leftFirst.channelSf.localeCompare(rightFirst.channelSf);
    })
    .map((evidence, index) => ({
      exhibitId: String.fromCharCode(65 + index),
      evidence,
    }));

  for (const { exhibitId, evidence } of exhibitGroups) {
    const speakerLabels = createSpeakerLabels(
      evidence.map(message => message.authorSf),
      caseRecord.subjectSf,
    );

    lines.push(`**EXHIBIT ${exhibitId}**`);

    for (const message of evidence) {
      const attachmentContext = message.attachments.some(
        attachment =>
          attachment.moderationStatus === AttachmentModerationStatus.IMPROPER,
      )
        ? ' [includes attachment deemed inappropriate]'
        : message.hadAttachments
          ? ' [has attachment]'
          : '';
      lines.push(
        `${speakerLabels[message.authorSf] ?? '[Person]'}${attachmentContext}: ${truncateEvidenceMessage(message.content)}`,
      );

      if (message.replySummary) {
        lines.push(`  ↳ In reply to: ${message.replySummary}`);
      }
    }

    lines.push('');
  }

  lines.push('```');

  return truncate(lines.join('\n'), maxLength);
}

function createSpeakerLabels(
  authorSfs: string[],
  subjectSf: string,
): Record<string, string> {
  return Object.fromEntries(
    [...new Set(authorSfs)].map((authorSf, index) => [
      authorSf,
      authorSf === subjectSf
        ? '[Subject]'
        : `[Person ${String.fromCharCode(65 + indexForNonSubject(authorSfs, subjectSf, authorSf))}]`,
    ]),
  );
}

function groupEvidenceByChannel(
  evidence: CaseWithEvidence['evidence'],
): Map<string, CaseWithEvidence['evidence']> {
  return evidence.reduce((grouped, message) => {
    const existing = grouped.get(message.channelSf) ?? [];
    existing.push(message);
    grouped.set(message.channelSf, existing);
    return grouped;
  }, new Map<string, CaseWithEvidence['evidence']>());
}

function indexForNonSubject(
  authorSfs: string[],
  subjectSf: string,
  authorSf: string,
): number {
  return [...new Set(authorSfs)]
    .filter(value => value !== subjectSf)
    .indexOf(authorSf);
}

function buildViewEvidenceRow(
  caseId: number,
): D.ActionRowBuilder<D.ButtonBuilder> {
  return new D.ActionRowBuilder<D.ButtonBuilder>().addComponents(
    new D.ButtonBuilder()
      .setCustomId(`case:view:${caseId}`)
      .setLabel('View evidence')
      .setStyle(D.ButtonStyle.Secondary),
  );
}

function buildJudgeRow(caseId: number): D.ActionRowBuilder<D.ButtonBuilder> {
  return new D.ActionRowBuilder<D.ButtonBuilder>().addComponents(
    new D.ButtonBuilder()
      .setCustomId(`case:judge:${caseId}`)
      .setLabel('Make judgement')
      .setStyle(D.ButtonStyle.Primary),
  );
}

function buildProsecuteRow(
  caseId: number,
  punishment: ActionablePunishment,
): D.ActionRowBuilder<D.ButtonBuilder> {
  return new D.ActionRowBuilder<D.ButtonBuilder>().addComponents(
    new D.ButtonBuilder()
      .setCustomId(`case:prosecute:${caseId}`)
      .setLabel(`${punishmentLabels[punishment]} them`)
      .setStyle(D.ButtonStyle.Danger),
  );
}

function memberOutranksBot(
  actor: D.GuildMember,
  botMember: D.GuildMember,
  ownerId: string,
): boolean {
  if (actor.id === ownerId) {
    return true;
  }

  if (actor.permissions.has(D.PermissionFlagsBits.Administrator)) {
    return true;
  }

  return actor.roles.highest.comparePositionTo(botMember.roles.highest) > 0;
}

function isGuildTextChannel(
  channel: D.GuildBasedChannel | null | undefined | void,
): channel is D.GuildTextBasedChannel {
  return !!channel && channel.isTextBased() && !channel.isDMBased();
}

function stringOrFallback(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function truncateEvidenceMessage(value: string): string {
  const max = 256;
  return value.length <= max ? value : value.slice(0, max) + '...';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 20)).trimEnd()}\n... (truncated)`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
