import { z } from 'zod';
import type { KimiTextOptions } from '../../src/kimi/api-runner.js';

type FetchImpl = NonNullable<KimiTextOptions['fetchImpl']>;

export const chatCompletionRequestSchema = z.object({
  model: z.string(),
  stream: z.literal(false),
  max_tokens: z.number(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  }).loose()).min(1),
}).loose();

export const kimiTextResultSchema = z.object({
  provider: z.string(),
  model: z.string(),
  text: z.string(),
  usage: z.object({
    total_tokens: z.number(),
  }).loose().nullable().optional(),
}).loose();

const headersSchema = z.object({
  authorization: z.string(),
}).loose();

const openAiResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string(),
    }).loose(),
  }).loose()),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).loose(),
}).loose();

export type CapturedKimiRequest = {
  url: string;
  authorization: string;
  body: z.infer<typeof chatCompletionRequestSchema>;
};

export type CapturedKimiRequestSlot = {
  request?: CapturedKimiRequest;
};

export function successfulPlanFetch(captured: CapturedKimiRequestSlot): FetchImpl {
  return async (url, options = {}) => {
    const headers = headersSchema.parse(options.headers);
    const bodyText = z.string().parse(options.body);
    captured.request = {
      url,
      authorization: headers.authorization,
      body: chatCompletionRequestSchema.parse(JSON.parse(bodyText) as unknown),
    };
    return {
      ok: true,
      status: 200,
      async json() {
        return openAiResponseSchema.parse({
          choices: [{ message: { content: 'API 计划输出' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      },
    };
  };
}
