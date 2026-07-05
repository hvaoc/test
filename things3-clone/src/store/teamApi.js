// Client for the account / team-management endpoints on the sync server. All
// calls use the SESSION token (identity), which authenticate() stored in the
// server config — distinct from the per-workspace SYNC token used for data.
import { serverConfig } from './backend';

function base() {
  const cfg = serverConfig();
  return cfg ? cfg.url.replace(/\/$/, '') : '';
}

async function req(method, path, body) {
  const cfg = serverConfig();
  if (!cfg || !cfg.session) throw new Error('not signed in');
  const r = await fetch(base() + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.session },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${method} ${path}: ${r.status}`);
  return j;
}

const q = (obj) =>
  '?' + Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// --- profile + verification ---
export const getProfile = () => req('GET', '/v1/profile');
export const resendVerification = () => req('POST', '/v1/resend-verification');

// Verify an email with a code (public endpoint). serverUrl lets the verify link
// work before the app is signed in.
export async function verifyEmail(code, serverUrl) {
  const url = (serverUrl || base() || 'http://localhost:8090').replace(/\/$/, '');
  const r = await fetch(url + '/v1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'this verification link is invalid or already used');
  return j;
}
export const updateProfile = (displayName, email) => req('POST', '/v1/profile', { displayName, email }).then((r) => r.profile);
export const changePassword = (oldPw, newPw) => req('POST', '/v1/password', { old: oldPw, new: newPw });

// --- workspaces ---
export const listWorkspaces = () => req('GET', '/v1/tenants').then((r) => r.tenants || []);
export const createWorkspace = (name) => req('POST', '/v1/tenants', { name }).then((r) => r.tenant);
export const renameWorkspace = (tenantId, name) => req('POST', '/v1/workspaces/rename', { tenantId, name }).then((r) => r.tenant);
export const deleteWorkspace = (tenantId) => req('POST', '/v1/workspaces/delete', { tenantId });
export const leaveWorkspace = (tenantId) => req('POST', '/v1/workspaces/leave', { tenantId });

// --- members ---
export const listMembers = (tenantId) => req('GET', '/v1/workspaces/members' + q({ tenantId })).then((r) => r.members || []);
export const changeMemberRole = (tenantId, userId, role) => req('POST', '/v1/workspaces/members/role', { tenantId, userId, role });
export const removeMember = (tenantId, userId) => req('POST', '/v1/workspaces/members/remove', { tenantId, userId });

// --- invitations ---
export const listInvites = (tenantId) => req('GET', '/v1/invites' + q({ tenantId })).then((r) => r.invites || []);
export const createInvite = (tenantId, role, email) => req('POST', '/v1/invites', { tenantId, role, email: email || '' }).then((r) => r.invite);
export const revokeInvite = (code) => req('POST', '/v1/invites/revoke', { code });
export const acceptInvite = (code) => req('POST', '/v1/invites/accept', { code }).then((r) => r.tenant);

// Public preview of an invite (no session). Falls back to the last-used server, or
// an explicit one, so the join screen works before sign-in.
export async function inviteInfo(code, serverUrl) {
  const url = (serverUrl || base()).replace(/\/$/, '');
  if (!url) throw new Error('no server');
  const r = await fetch(url + '/v1/invites/info' + q({ code }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'invite not found');
  return j.invite;
}
