import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { search } from '../../retrieval/search.js';
import { buildPrompt } from '../../retrieval/prompt.js';
import type { ChatCompletionRequest } from '../../types/index.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

export async function chatRoutes(app: FastifyInstance) {
  app.post('/chat/completions', async (request, reply) => {
    const body = request.body as ChatCompletionRequest;
    const messages = body.messages ?? [];
    const stream = body.stream ?? false;

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) {
      return reply.status(400).send({
        error: { message: 'No user message found', type: 'invalid_request_error' },
      });
    }

    const query = lastUserMessage.content;
    const results = await search(query, {}, 5);
    const prompt = buildPrompt(query, results);

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const response = await llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      });

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      for await (const chunk of response) {
        const data = JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model ?? config.llmModel,
          choices: [
            {
              index: 0,
              delta: { content: chunk.choices[0]?.delta?.content ?? '' },
              finish_reason: chunk.choices[0]?.finish_reason,
            },
          ],
        });
        reply.raw.write(`data: ${data}\n\n`);
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    const response = await llmClient.chat.completions.create({
      model: config.llmModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens,
      top_p: body.top_p ?? 1,
    });

    const choice = response.choices[0];
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: body.model ?? config.llmModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: choice?.message?.content ?? '',
          },
          finish_reason: choice?.finish_reason ?? 'stop',
        },
      ],
      usage: response.usage,
    };
  });
}
