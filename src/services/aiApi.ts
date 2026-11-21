import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import type { AiChatResponse, AiStatusResponse } from '../types';

const AI_API_BASE = (
  import.meta.env.VITE_AI_API_URL ||
  import.meta.env.VITE_TELEGRAM_API_URL ||
  ''
)
  .trim()
  .replace(/\/+$/, '');

function resolveAiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return AI_API_BASE ? `${AI_API_BASE}${normalized}` : normalized;
}

async function getCurrentFirebaseUser(timeoutMs = 2500): Promise<User | null> {
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser;

  return new Promise<User | null>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(auth.currentUser || null);
    }, timeoutMs);

    const unsub = onAuthStateChanged(
      auth,
      user => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(user);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(null);
      }
    );
  });
}

export class AiClientError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function fetchSkillFlixAiStatus(): Promise<AiStatusResponse> {
  const res = await fetch(resolveAiUrl('/api/ai/status'), {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new AiClientError(503, 'AI_BACKEND_UNREACHABLE', 'Skill-Flix AI service is unavailable.');
  }
  const data = (await res.json()) as AiStatusResponse & { error?: string };
  if (!res.ok) {
    throw new AiClientError(res.status, 'AI_STATUS_ERROR', data.error || 'Could not reach Skill-Flix AI.');
  }
  return data;
}

export async function sendSkillFlixAiMessage(params: {
  message: string;
  history: Array<{ role: 'user' | 'model'; text: string }>;
}): Promise<AiChatResponse> {
  const user = await getCurrentFirebaseUser();
  if (!user) {
    throw new AiClientError(
      401,
      'AUTH_REQUIRED',
      'Please sign in to your Skill-Flix account to start chatting with Skill-Flix AI.'
    );
  }

  const idToken = await user.getIdToken();
  let res: Response;
  try {
    res = await fetch(resolveAiUrl('/api/ai/chat'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(params)
    });
  } catch {
    throw new AiClientError(
      503,
      'NETWORK_ERROR',
      'Network connection interrupted while contacting Skill-Flix AI. Please try again.'
    );
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new AiClientError(
      res.status || 502,
      'INVALID_SERVER_RESPONSE',
      'Skill-Flix AI server returned an unexpected response.'
    );
  }

  const payload = (await res.json()) as Partial<AiChatResponse> & {
    error?: string;
    code?: string;
  };

  if (!res.ok || !payload.reply) {
    throw new AiClientError(
      res.status,
      payload.code || 'AI_REQUEST_FAILED',
      payload.error || 'Skill-Flix AI could not answer right now. Please try again.'
    );
  }

  return payload as AiChatResponse;
}
