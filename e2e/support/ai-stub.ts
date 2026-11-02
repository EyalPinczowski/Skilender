import { createServer, type Server } from 'node:http';
import { WORKER_ENV, requireEnv } from './env';

/**
 * A local, scripted stand-in for the AI providers' HTTPS APIs. TEST INFRASTRUCTURE.
 *
 * The API runs its real Groq and Cloudflare provider code; support/ai-fetch-preload.mjs points their
 * HTTPS calls here. By default every call is answered: valid feedback JSON when JSON was asked for,
 * a fixed line of chat otherwise. A test queues exceptions per provider with `scriptAi` (a status
 * such as 429, or a text), which are used one per call, in order. No key, no model, no network.
 */

export interface ScriptItem {
  /** An HTTP status to answer with instead of a reply (for example 429). */
  status?: number;
  /** The text the "model" answers with. */
  content?: string;
}

export const CHAT_REPLY = 'Tell me about a time you had to fix a messy spreadsheet.';
export const FEEDBACK = {
  score: 7,
  strengths: 'Clear structure and one concrete example.',
  improve: 'Say what the result was, in numbers.',
  next_focus: 'Open with the outcome.',
};

export interface AiCall {
  provider: string;
  json: boolean;
}

export function startAiStub(port: number): Promise<{ server: Server; close: () => Promise<void> }> {
  const scripts = new Map<string, ScriptItem[]>();
  let calls: AiCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://stub').pathname;
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (path === '/__script' && request.method === 'POST') {
        const { provider, items } = JSON.parse(body) as { provider: string; items: ScriptItem[] };
        scripts.set(provider, items);
        return send(200, {});
      }
      if (path === '/__reset' && request.method === 'POST') {
        scripts.clear();
        calls = [];
        return send(200, {});
      }
      if (path === '/__calls' && request.method === 'GET') return send(200, calls);
      const provider = path.slice(1);
      if (request.method !== 'POST' || !['groq', 'cloudflare-ai'].includes(provider)) {
        return send(404, {});
      }
      // Both providers add the same sentence to the system text when JSON is wanted.
      const asked = JSON.parse(body) as { messages?: { role: string; content: string }[] };
      const json = (asked.messages?.[0]?.content ?? '').includes('Reply with one JSON object only');
      calls.push({ provider, json });
      const item = scripts.get(provider)?.shift();
      if (item?.status) return send(item.status, { error: 'scripted' });
      const content = item?.content ?? (json ? JSON.stringify(FEEDBACK) : CHAT_REPLY);
      return send(200, { model: 'stub-1', choices: [{ message: { content } }] });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      }),
    );
  });
}

const stubUrl = () => requireEnv(WORKER_ENV.aiStubUrl);

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stubUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`AI stub ${path} answered ${response.status}`);
}

/** Forgets every script and recorded call. Call it at the start of a test that uses the AI. */
export const resetAi = () => post('/__reset', {});

/** Queues answers for the next calls to one provider (used one per call, then the default). */
export const scriptAi = (provider: 'groq' | 'cloudflare-ai', items: ScriptItem[]) =>
  post('/__script', { provider, items });

/** What the stub was asked since the last reset. */
export async function aiCalls(): Promise<AiCall[]> {
  return (await (await fetch(`${stubUrl()}/__calls`)).json()) as AiCall[];
}
