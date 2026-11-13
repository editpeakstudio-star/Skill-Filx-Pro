import { HttpError, type WorkerEnv } from './types';

const DEFAULT_PROJECT_ID = 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const GOOGLE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

interface CachedJwks {
  keys: Array<JsonWebKey & { kid?: string }>;
  expiresAt: number;
}

interface CachedServiceToken {
  accessToken: string;
  expiresAt: number;
  clientEmail: string;
}

let jwkCache: CachedJwks | null = null;
let serviceTokenCache: CachedServiceToken | null = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlToUint8Array(segment: string): Uint8Array<ArrayBuffer> {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stringToBase64Url(str: string): string {
  return uint8ArrayToBase64Url(encoder.encode(str));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function getProjectId(env: WorkerEnv): string {
  return (env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
}

async function fetchGoogleJwks(forceRefresh = false): Promise<Array<JsonWebKey & { kid?: string }>> {
  const now = Date.now();
  if (!forceRefresh && jwkCache && jwkCache.expiresAt > now) {
    return jwkCache.keys;
  }

  const res = await fetch(GOOGLE_JWK_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new HttpError(502, `Failed to fetch Firebase signing keys (${res.status}).`);
  }

  const json = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = Array.isArray(json.keys) ? json.keys : [];
  const cc = res.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  jwkCache = {
    keys,
    expiresAt: now + Math.max(60, maxAge) * 1000
  };
  return keys;
}

export interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

export interface VerifiedAdmin extends VerifiedUser {
  role: 'owner' | 'master_admin' | 'admin';
  permissions: string[];
}

export async function verifyFirebaseIdToken(
  idToken: string,
  env: WorkerEnv
): Promise<VerifiedUser> {
  if (!idToken || typeof idToken !== 'string') {
    throw new HttpError(401, 'Missing Firebase authentication token.');
  }

  const parts = idToken.trim().split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Invalid Firebase authentication token format.');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(base64UrlToUint8Array(headerB64))) as {
      alg?: string;
      kid?: string;
    };
    payload = JSON.parse(decoder.decode(base64UrlToUint8Array(payloadB64))) as Record<
      string,
      unknown
    >;
  } catch {
    throw new HttpError(401, 'Malformed Firebase authentication token.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new HttpError(401, 'Unsupported Firebase token algorithm.');
  }

  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleJwks(true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) {
    throw new HttpError(401, 'Firebase signing key was not found.');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlToUint8Array(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`)
  );

  if (!signatureValid) {
    throw new HttpError(401, 'Invalid Firebase ID token signature.');
  }

  const projectId = getProjectId(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  const authTime = Number(payload.auth_time || 0);
  const sub = typeof payload.sub === 'string' ? payload.sub : '';

  if (payload.aud !== projectId) {
    throw new HttpError(401, 'Firebase token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new HttpError(401, 'Firebase token issuer mismatch.');
  }
  if (!sub) {
    throw new HttpError(401, 'Firebase token subject is missing.');
  }
  if (exp <= nowSec) {
    throw new HttpError(401, 'Firebase session expired. Please sign in again.');
  }
  if (iat > nowSec + 300 || authTime > nowSec + 300) {
    throw new HttpError(401, 'Firebase token timestamp is invalid.');
  }

  return {
    uid: sub,
    email: typeof payload.email === 'string' ? payload.email.trim() : '',
    emailVerified: payload.email_verified === true,
    idToken
  };
}

export function hasServiceAccountConfig(env: WorkerEnv): boolean {
  return Boolean(env.FIREBASE_CLIENT_EMAIL?.trim() && env.FIREBASE_PRIVATE_KEY?.trim());
}

export async function getServiceAccountAccessToken(env: WorkerEnv): Promise<string> {
  const clientEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKeyPem = (env.FIREBASE_PRIVATE_KEY || '').trim();
  if (!clientEmail || !privateKeyPem) {
    throw new HttpError(
      500,
      'Firebase Service Account secrets (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) are not configured in Cloudflare Worker.'
    );
  }

  const nowMs = Date.now();
  if (
    serviceTokenCache &&
    serviceTokenCache.clientEmail === clientEmail &&
    serviceTokenCache.expiresAt > nowMs + 60_000
  ) {
    return serviceTokenCache.accessToken;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const headerB64 = stringToBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimB64 = stringToBase64Url(
    JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/datastore',
      iat: nowSec,
      exp: nowSec + 3600
    })
  );

  const keyData = pemToArrayBuffer(privateKeyPem);
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signingInput = `${headerB64}.${claimB64}`;
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    encoder.encode(signingInput)
  );
  const assertion = `${signingInput}.${uint8ArrayToBase64Url(new Uint8Array(sigBuf))}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });

  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new HttpError(
      500,
      `Google OAuth token exchange failed: ${tokenJson.error_description || tokenJson.error || tokenRes.status}`
    );
  }

  serviceTokenCache = {
    accessToken: tokenJson.access_token,
    expiresAt: nowMs + Math.max(300, Number(tokenJson.expires_in || 3600)) * 1000,
    clientEmail
  };

  return serviceTokenCache.accessToken;
}

export async function getFirestoreAuthToken(
  env: WorkerEnv,
  callerIdToken?: string,
  requireServiceAccount = false
): Promise<string> {
  if (hasServiceAccountConfig(env)) {
    return getServiceAccountAccessToken(env);
  }
  if (requireServiceAccount || !callerIdToken) {
    throw new HttpError(
      500,
      'Configure FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY secrets in Cloudflare Worker so server-side payment notifications can read active bots and save logs.'
    );
  }
  return callerIdToken;
}

// ======================================================
// FIRESTORE REST API HELPERS (Spark-Compatible)
// ======================================================

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function decodeValue(val: FirestoreValue): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      out[k] = decodeValue(v);
    }
    return out;
  }
  return undefined;
}

function encodeValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encodeValue) } };
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = encodeValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decodeDocument(docJson: {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (docJson.name) {
    const parts = docJson.name.split('/');
    out.id = parts[parts.length - 1];
  }
  if (docJson.fields) {
    for (const [k, v] of Object.entries(docJson.fields)) {
      out[k] = decodeValue(v);
    }
  }
  return out;
}

function encodeFields(data: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = encodeValue(v);
  }
  return fields;
}

function baseDocPath(projectId: string, collection: string, docId?: string): string {
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodeURIComponent(collection)}`;
  return docId ? `${base}/${encodeURIComponent(docId)}` : base;
}

export async function getFirestoreDoc(
  env: WorkerEnv,
  authToken: string,
  collection: string,
  docId: string
): Promise<Record<string, unknown> | null> {
  const res = await fetch(baseDocPath(getProjectId(env), collection, docId), {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status === 403 ? 403 : 502, `Firestore read failed (${res.status}): ${text.slice(0, 180)}`);
  }
  const json = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
  return decodeDocument(json);
}

export async function listFirestoreCollection(
  env: WorkerEnv,
  authToken: string,
  collection: string
): Promise<Record<string, unknown>[]> {
  const projectId = getProjectId(env);
  const items: Record<string, unknown>[] = [];
  let pageToken = '';

  for (let i = 0; i < 10; i++) {
    const url = new URL(baseDocPath(projectId, collection));
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status === 403 ? 403 : 502, `Firestore list failed (${res.status}): ${text.slice(0, 180)}`);
    }
    const json = (await res.json()) as {
      documents?: Array<{ name?: string; fields?: Record<string, FirestoreValue> }>;
      nextPageToken?: string;
    };
    if (Array.isArray(json.documents)) {
      for (const docItem of json.documents) {
        items.push(decodeDocument(docItem));
      }
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return items;
}

/**
 * Atomically creates a Firestore document ONLY if it does not already exist.
 * Returns true if created, false if already exists (idempotency claim).
 */
export async function createFirestoreDocIfNotExists(
  env: WorkerEnv,
  authToken: string,
  collection: string,
  docId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const url = `${baseDocPath(getProjectId(env), collection, docId)}?currentDocument.exists=false`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: encodeFields(data) })
  });

  if (res.status === 409 || res.status === 400) {
    return false;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `Firestore create claim failed (${res.status}): ${text.slice(0, 180)}`);
  }
  return true;
}

export async function upsertFirestoreDoc(
  env: WorkerEnv,
  authToken: string,
  collection: string,
  docId: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await fetch(baseDocPath(getProjectId(env), collection, docId), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: encodeFields(data) })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status === 403 ? 403 : 502, `Firestore upsert failed (${res.status}): ${text.slice(0, 180)}`);
  }
}

export async function patchFirestoreDocFields(
  env: WorkerEnv,
  authToken: string,
  collection: string,
  docId: string,
  updates: Record<string, unknown>,
  deleteFields: string[] = []
): Promise<void> {
  const url = new URL(baseDocPath(getProjectId(env), collection, docId));
  const fieldPaths = [...Object.keys(updates), ...deleteFields];
  for (const field of fieldPaths) {
    url.searchParams.append('updateMask.fieldPaths', field);
  }

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: encodeFields(updates) })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status === 403 ? 403 : 502, `Firestore patch failed (${res.status}): ${text.slice(0, 180)}`);
  }
}

export async function deleteFirestoreDoc(
  env: WorkerEnv,
  authToken: string,
  collection: string,
  docId: string
): Promise<void> {
  const res = await fetch(baseDocPath(getProjectId(env), collection, docId), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status === 403 ? 403 : 502, `Firestore delete failed (${res.status}): ${text.slice(0, 180)}`);
  }
}

export async function authorizeAdmin(
  authHeader: string | null,
  env: WorkerEnv,
  requiredPermission: 'telegram.manage' | 'payments.verify' = 'telegram.manage'
): Promise<VerifiedAdmin> {
  const match = (authHeader || '').match(/^Bearer\s+(.+)$/i);
  const idToken = match ? match[1].trim() : '';
  const user = await verifyFirebaseIdToken(idToken, env);

  if (user.email.toLowerCase() === PLATFORM_OWNER_EMAIL && user.emailVerified) {
    return {
      ...user,
      role: 'owner',
      permissions: ['telegram.manage', 'payments.verify', 'settings.manage']
    };
  }

  const fsToken = await getFirestoreAuthToken(env, idToken, false);
  const profile = await getFirestoreDoc(env, fsToken, 'users', user.uid);
  if (!profile) {
    throw new HttpError(403, 'Forbidden: Administrator profile not found.');
  }
  if (profile.isSuspended === true) {
    throw new HttpError(403, 'Forbidden: Your administrator account is suspended.');
  }

  const role = typeof profile.role === 'string' ? profile.role : 'user';
  const permissions = Array.isArray(profile.permissions)
    ? profile.permissions.filter((p): p is string => typeof p === 'string')
    : [];

  if (role === 'master_admin') {
    return { ...user, role: 'master_admin', permissions };
  }

  if (role === 'admin') {
    const allowed =
      permissions.includes(requiredPermission) ||
      (requiredPermission === 'telegram.manage' && permissions.includes('settings.manage'));
    if (allowed) {
      return { ...user, role: 'admin', permissions };
    }
  }

  throw new HttpError(403, 'Forbidden: You do not have permission to access Telegram Bot Manager.');
}
