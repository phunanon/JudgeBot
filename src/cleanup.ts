import * as D from 'discord.js';
import { AttachmentModerationStatus } from '@prisma/client';

import { moderateAttachment, openai } from './ai.js';
import { prisma } from './db.js';

const noTextFallback = '*No text content*';
const activeCleanups = new Set<number>();

export function buildCleanupRow(
  caseId: number,
): D.ActionRowBuilder<D.ButtonBuilder> {
  return new D.ActionRowBuilder<D.ButtonBuilder>().addComponents(
    new D.ButtonBuilder()
      .setCustomId(`case:cleanup:${caseId}`)
      .setLabel('Clean up inappropriate messages')
      .setStyle(D.ButtonStyle.Danger),
  );
}

export async function handleCleanup(
  interaction: D.ButtonInteraction,
  caseId: number,
): Promise<void> {
  if (activeCleanups.has(caseId)) {
    await interaction
      .reply({
        content: `Cleanup is already in progress for case #${caseId}.`,
        flags: [D.MessageFlags.Ephemeral],
      })
      .catch(e => console.error(e));
    return;
  }

  activeCleanups.add(caseId);

  try {
    await TryCleanup(interaction, caseId);
  } finally {
    activeCleanups.delete(caseId);
  }
}

async function TryCleanup(interaction: D.ButtonInteraction, caseId: number) {
  await interaction.deferReply().catch(e => console.error(e));
  if (!interaction.guild) {
    await interaction.editReply('Cleanup can only happen inside a server.');
    return;
  }

  await interaction.message
    .edit({ components: [] })
    .catch(e => console.error(e));

  const caseRecord = await prisma.case.findUnique({
    where: { id: caseId },
    include: { evidence: { include: { attachments: true } } },
  });

  if (!caseRecord) {
    await interaction
      .editReply('That case could not be found.')
      .catch(e => console.error(e));
    return;
  }

  const subjectEvidence = caseRecord.evidence.filter(
    evidence => evidence.authorSf === caseRecord.subjectSf,
  );

  if (subjectEvidence.length === 0) {
    await interaction
      .editReply(
        `Case #${caseRecord.id} has no captured subject messages to clean up.`,
      )
      .catch(e => console.error(e));
    return;
  }

  let deletedCount = 0;
  let alreadyMissingCount = 0;
  let failedDeleteCount = 0;
  let textFlaggedCount = 0;
  let attachmentFlaggedCount = 0;
  let keptCount = 0;

  for (const evidence of subjectEvidence) {
    const flaggedByAttachment = await IsAttachmentImproper(
      evidence.attachments,
    );
    const flaggedByText = await IsTextImproper(evidence.content);

    if (flaggedByAttachment) {
      attachmentFlaggedCount += 1;
    }

    if (flaggedByText) {
      textFlaggedCount += 1;
    }

    if (!flaggedByAttachment && !flaggedByText) {
      keptCount += 1;
      continue;
    }

    const deleteResult = await deleteEvidenceMessage(
      interaction.guild,
      evidence,
    );

    if (deleteResult === 'DELETED') {
      deletedCount += 1;
      continue;
    }

    if (deleteResult === 'MISSING') {
      alreadyMissingCount += 1;
      continue;
    }

    failedDeleteCount += 1;
  }

  const messageParts: string[] = [];
  if (deletedCount) messageParts.push(`${deletedCount}x deleted`);
  if (alreadyMissingCount) messageParts.push(`${alreadyMissingCount}x missing`);
  if (failedDeleteCount) messageParts.push(`${failedDeleteCount}x failed`);
  if (keptCount) messageParts.push(`${keptCount}x kept`);

  const flaggedParts: string[] = [];
  if (textFlaggedCount) flaggedParts.push(`${textFlaggedCount}x text`);
  if (attachmentFlaggedCount)
    flaggedParts.push(`${attachmentFlaggedCount}x attachment`);

  const summary = `Messages: ${messageParts.join(', ')}; flagged by: ${flaggedParts.join(', ')}`;
  await interaction.editReply(summary).catch(e => console.error(e));
}

type Attachment = {
  id: number;
  moderationStatus: AttachmentModerationStatus;
  url: string;
};
async function IsAttachmentImproper(attachments: Attachment[]) {
  for (const attachment of attachments) {
    if (attachment.moderationStatus === AttachmentModerationStatus.IMPROPER)
      return true;

    if (attachment.moderationStatus !== AttachmentModerationStatus.PENDING)
      continue;

    const moderation = await moderateAttachment(attachment.url);
    const status =
      moderation.status === 'IMPROPER'
        ? AttachmentModerationStatus.IMPROPER
        : AttachmentModerationStatus.CLEAN;

    await prisma.evidenceAttachment.update({
      where: { id: attachment.id },
      data: { moderationStatus: status, moderationRaw: moderation.raw },
    });

    return status === AttachmentModerationStatus.IMPROPER;
  }
}

export async function IsTextImproper(content: string) {
  const trimmed = content.trim();

  if (!trimmed || trimmed === noTextFallback) return false;

  const moderation = await openai.moderations.create({
    input: trimmed,
    model: 'omni-moderation-latest',
  });

  return moderation.results.some(result =>
    Object.values(result.category_scores).some(score => score > 0.2),
  );
}

async function deleteEvidenceMessage(
  guild: D.Guild,
  evidence: {
    channelSf: string;
    messageSf: string;
  },
): Promise<'DELETED' | 'MISSING' | 'FAILED'> {
  const channel = await guild.channels.fetch(evidence.channelSf).catch(e => {
    console.error(e);
    return null;
  });

  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return 'FAILED';
  }

  if (!('messages' in channel)) {
    return 'FAILED';
  }

  const message = await channel.messages.fetch(evidence.messageSf).catch(e => {
    if (e instanceof Error && /Unknown Message/i.test(e.message)) {
      return null;
    }

    console.error(e);
    return undefined;
  });

  if (message === null) {
    return 'MISSING';
  }

  if (!message) {
    return 'FAILED';
  }

  const deleted = await message.delete().catch(e => {
    console.error(e);
    return null;
  });

  return deleted ? 'DELETED' : 'FAILED';
}
