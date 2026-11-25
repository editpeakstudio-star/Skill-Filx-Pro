import { PermissionKey, SYSTEM_PERMISSIONS, UserProfile, UserRole } from '../types';

export const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const MAX_DISPLAY_NAME_LENGTH = 160;

export interface AuthUserSnapshot {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  providerData?: Array<{ providerId?: string | null; email?: string | null }>;
  metadata?: {
    creationTime?: string | null;
    lastSignInTime?: string | null;
  };
}

export function resolveAuthProvider(
  fbUser?: AuthUserSnapshot | null,
  existingProvider?: string
): string {
  const providerId = fbUser?.providerData?.[0]?.providerId;
  if (providerId === 'google.com') return 'google';
  if (providerId === 'password') return 'password';
  if (providerId === 'phone') return 'phone';
  if (providerId) return providerId;
  return existingProvider || 'email/password';
}

export function toIsoDateValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof (value as { toDate?: () => Date })?.toDate === 'function') {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
    } catch {
      return undefined;
    }
  }
  const maybeSeconds = (value as { seconds?: unknown; _seconds?: unknown })?.seconds ??
    (value as { _seconds?: unknown })?._seconds;
  if (typeof maybeSeconds === 'number' && Number.isFinite(maybeSeconds)) {
    const d = new Date(maybeSeconds * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function sanitizeDisplayName(name: string | null | undefined, fallback = 'Student'): string {
  const cleaned = String(name || '').trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return cleaned || fallback;
}

export function isOwnerAuthUser(fbUser?: AuthUserSnapshot | null): boolean {
  return (
    !!fbUser &&
    fbUser.emailVerified === true &&
    String(fbUser.email || '').trim().toLowerCase() === PLATFORM_OWNER_EMAIL
  );
}

export function normalizeUserProfile(
  uid: string,
  rawData: Record<string, any>,
  fbUser?: AuthUserSnapshot | null
): UserProfile {
  const email = String(rawData.email || fbUser?.email || '').trim();
  const isOwner = rawData.isPlatformOwner === true || isOwnerAuthUser(fbUser);
  const role: UserRole = isOwner
    ? 'master_admin'
    : rawData.role === 'admin' || rawData.role === 'master_admin'
      ? rawData.role
      : 'user';
  const suspended = isOwner ? false : (rawData.isSuspended === true || rawData.accountStatus === 'suspended');
  const mergedCourses = Array.from(
    new Set([
      ...(Array.isArray(rawData.allowedCategories) ? rawData.allowedCategories : []),
      ...(Array.isArray(rawData.assignedCourses) ? rawData.assignedCourses : [])
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0))
  );
  const createdAt =
    toIsoDateValue(rawData.createdAt) ||
    toIsoDateValue(fbUser?.metadata?.creationTime) ||
    new Date().toISOString();
  const lastLoginAt =
    toIsoDateValue(rawData.lastLoginAt) ||
    toIsoDateValue(rawData.lastLogin) ||
    toIsoDateValue(fbUser?.metadata?.lastSignInTime) ||
    createdAt;
  const accessExpiry = rawData.accessExpiry === null
    ? null
    : toIsoDateValue(rawData.accessExpiry) ?? toIsoDateValue(rawData.accessExpiryAt) ?? null;

  const displayName = sanitizeDisplayName(
    rawData.displayName ||
      fbUser?.displayName ||
      fbUser?.phoneNumber ||
      (email ? email.split('@')[0] : '') ||
      'Student'
  );

  return {
    uid,
    email,
    displayName,
    photoURL: fbUser?.photoURL || rawData.photoURL || undefined,
    phoneNumber: fbUser?.phoneNumber || rawData.phoneNumber || undefined,
    authProvider: resolveAuthProvider(fbUser, rawData.authProvider),
    role,
    isPlatformOwner: isOwner,
    predefinedRole: isOwner ? 'owner' : rawData.predefinedRole,
    assignedRoleTitle: isOwner ? 'Platform Owner' : rawData.assignedRoleTitle,
    permissions: isOwner
      ? SYSTEM_PERMISSIONS.map((p): PermissionKey => p.key)
      : Array.isArray(rawData.permissions)
        ? rawData.permissions
        : [],
    isSuspended: suspended,
    accountStatus: suspended ? 'suspended' : 'active',
    hasAllAccess: isOwner || rawData.hasAllAccess === true,
    allowedCategories: mergedCourses,
    assignedCourses: mergedCourses,
    allowedFolders: Array.isArray(rawData.allowedFolders) ? rawData.allowedFolders : [],
    subscriptionStatus: isOwner
      ? 'active'
      : rawData.subscriptionStatus || (mergedCourses.length > 0 || rawData.hasAllAccess === true ? 'active' : 'none'),
    accessExpiry,
    lastLogin: lastLoginAt,
    lastLoginAt,
    createdAt
  };
}

export function resolveSyncedDisplayName(params: {
  explicitDisplayName?: string;
  pendingName?: string;
  existingDisplayName?: unknown;
  fbUser?: AuthUserSnapshot | null;
  email?: string;
}): string {
  const emailLocal = (params.email || params.fbUser?.email || '').split('@')[0];
  return sanitizeDisplayName(
    params.explicitDisplayName ||
      params.pendingName ||
      (typeof params.existingDisplayName === 'string' ? params.existingDisplayName : '') ||
      params.fbUser?.displayName ||
      params.fbUser?.phoneNumber ||
      emailLocal ||
      'Student'
  );
}

export function buildNewUserDocument(
  fbUser: AuthUserSnapshot,
  options: {
    explicitDisplayName?: string;
    pendingName?: string;
    nowIso?: string;
  } = {}
): { profile: UserProfile; firestoreDoc: Record<string, any> } {
  const nowIso = options.nowIso || new Date().toISOString();
  const isOwner = isOwnerAuthUser(fbUser);
  const email = String(fbUser.email || '').trim();
  const authProvider = resolveAuthProvider(fbUser);
  const displayName = resolveSyncedDisplayName({
    explicitDisplayName: options.explicitDisplayName,
    pendingName: options.pendingName,
    fbUser,
    email
  });
  const createdAt = toIsoDateValue(fbUser.metadata?.creationTime) || nowIso;

  const profile: UserProfile = {
    uid: fbUser.uid,
    email,
    displayName,
    photoURL: fbUser.photoURL || undefined,
    phoneNumber: fbUser.phoneNumber || undefined,
    authProvider,
    role: isOwner ? 'master_admin' : 'user',
    isPlatformOwner: isOwner,
    predefinedRole: isOwner ? 'owner' : undefined,
    assignedRoleTitle: isOwner ? 'Platform Owner' : undefined,
    permissions: isOwner ? SYSTEM_PERMISSIONS.map((p): PermissionKey => p.key) : [],
    isSuspended: false,
    accountStatus: 'active',
    hasAllAccess: isOwner,
    allowedCategories: [],
    assignedCourses: [],
    allowedFolders: [],
    subscriptionStatus: isOwner ? 'active' : 'none',
    accessExpiry: null,
    lastLogin: nowIso,
    lastLoginAt: nowIso,
    createdAt
  };

  const firestoreDoc = Object.fromEntries(
    Object.entries({
      ...profile,
      accessExpiryAt: null
    }).filter(([, value]) => value !== undefined)
  );

  return { profile, firestoreDoc };
}

export function buildExistingUserUpdatePayload(params: {
  fbUser: AuthUserSnapshot;
  existingData: Record<string, any>;
  explicitDisplayName?: string;
  pendingName?: string;
  updateLastLogin?: boolean;
  nowIso?: string;
}): { updatePayload: Record<string, any>; mergedProfile: UserProfile } {
  const { fbUser, existingData } = params;
  const nowIso = params.nowIso || new Date().toISOString();
  const isOwner = isOwnerAuthUser(fbUser);
  const authProvider = resolveAuthProvider(fbUser, existingData.authProvider);
  const resolvedName = resolveSyncedDisplayName({
    explicitDisplayName: params.explicitDisplayName,
    pendingName: params.pendingName,
    existingDisplayName: existingData.displayName,
    fbUser,
    email: existingData.email || fbUser.email || ''
  });

  const updatePayload: Record<string, any> = {};
  if (existingData.uid !== fbUser.uid) {
    updatePayload.uid = fbUser.uid;
  }

  const existingName = typeof existingData.displayName === 'string' ? existingData.displayName.trim() : '';
  const emailPrefix = String(existingData.email || fbUser.email || '').split('@')[0];
  const shouldUpgradeGenericName =
    !existingName ||
    existingName === 'Student' ||
    (Boolean(emailPrefix) && existingName === emailPrefix && Boolean(params.explicitDisplayName || params.pendingName || fbUser.displayName));

  if (resolvedName && existingName !== resolvedName && (shouldUpgradeGenericName || Boolean(params.explicitDisplayName))) {
    updatePayload.displayName = resolvedName;
  }

  if (fbUser.photoURL && fbUser.photoURL !== (existingData.photoURL || undefined)) {
    updatePayload.photoURL = fbUser.photoURL;
  }

  if (fbUser.phoneNumber && fbUser.phoneNumber !== (existingData.phoneNumber || undefined)) {
    updatePayload.phoneNumber = fbUser.phoneNumber;
  }

  if (existingData.authProvider !== authProvider) {
    updatePayload.authProvider = authProvider;
  }

  if (params.updateLastLogin || !existingData.lastLoginAt || !existingData.lastLogin) {
    updatePayload.lastLogin = nowIso;
    updatePayload.lastLoginAt = nowIso;
  }

  if (isOwner) {
    if (existingData.isPlatformOwner !== true) updatePayload.isPlatformOwner = true;
    if (existingData.role !== 'master_admin') updatePayload.role = 'master_admin';
    if (existingData.hasAllAccess !== true) updatePayload.hasAllAccess = true;
    if (existingData.subscriptionStatus !== 'active') updatePayload.subscriptionStatus = 'active';
    if (existingData.accountStatus !== 'active') updatePayload.accountStatus = 'active';
    if (existingData.isSuspended !== false) updatePayload.isSuspended = false;
  }

  const mergedProfile = normalizeUserProfile(
    fbUser.uid,
    {
      ...existingData,
      ...updatePayload
    },
    fbUser
  );

  return { updatePayload, mergedProfile };
}

export function dedupeAndSortUsers(users: UserProfile[]): UserProfile[] {
  const byUid = new Map<string, UserProfile>();
  for (const user of users) {
    if (!user || !user.uid) continue;
    byUid.set(user.uid, user);
  }

  return Array.from(byUid.values()).sort((a, b) => {
    const aOwner = a.isPlatformOwner === true;
    const bOwner = b.isPlatformOwner === true;
    if (aOwner !== bOwner) return aOwner ? -1 : 1;

    const bTime = new Date(b.lastLoginAt || b.lastLogin || b.createdAt || 0).getTime();
    const aTime = new Date(a.lastLoginAt || a.lastLogin || a.createdAt || 0).getTime();
    const safeB = Number.isFinite(bTime) ? bTime : 0;
    const safeA = Number.isFinite(aTime) ? aTime : 0;
    return safeB - safeA;
  });
}

export function isTransientOrConflictSyncError(err: unknown): {
  isAlreadyExists: boolean;
  isPermissionDenied: boolean;
  isOfflineOrUnavailable: boolean;
} {
  const code = String((err as { code?: string })?.code || '').toLowerCase();
  const message = String((err as { message?: string })?.message || '').toLowerCase();
  return {
    isAlreadyExists: code.includes('already-exists') || message.includes('already exists'),
    isPermissionDenied: code.includes('permission-denied') || message.includes('missing or insufficient permissions'),
    isOfflineOrUnavailable:
      code.includes('unavailable') ||
      code.includes('failed-precondition') ||
      message.includes('offline') ||
      message.includes('unavailable')
  };
}
