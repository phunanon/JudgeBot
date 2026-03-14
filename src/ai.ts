import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';

const judgementSchema = z.object({
  summary: z.string().min(1),
  punishment: z.enum(['BAN', 'KICK', 'MUTE', 'NONE']),
});

export type JudgementResult = z.infer<typeof judgementSchema>;

export type AttachmentModerationResult = {
  status: 'CLEAN' | 'IMPROPER';
  raw: string;
};

export const openai = new OpenAI({
  apiKey: config.openAiApiKey,
});

export async function moderateAttachment(
  url: string,
): Promise<AttachmentModerationResult> {
  const input = [{ type: 'image_url', image_url: { url } } as const];
  const moderation = await openai.moderations.create({
    input,
    model: 'omni-moderation-latest',
  });

  const improper = moderation.results.some(result => result.flagged);

  return {
    status: improper ? 'IMPROPER' : 'CLEAN',
    raw: JSON.stringify(moderation),
  };
}

export async function generateJudgement(
  evidenceReport: string,
): Promise<JudgementResult> {
  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    reasoning: { effort: 'minimal' },
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You are a moderation assistant. Review the evidence and make an executive judgement about what should happen to [Subject].',
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: evidenceReport }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'judgement',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: {
              type: 'string',
              description: 'A brief judgement summary for moderators.',
            },
            punishment: {
              type: 'string',
              enum: ['BAN', 'KICK', 'MUTE', 'NONE'],
              description: 'The recommended punishment to apply. Mutes are for 8 hours.',
            },
          },
          required: ['summary', 'punishment'],
        },
      },
    },
  });

  const outputText = response.output_text?.trim();

  if (!outputText) {
    throw new Error('OpenAI did not return a judgement payload.');
  }

  return judgementSchema.parse(JSON.parse(outputText));
}
