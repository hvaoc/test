import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import { serverConfig } from '../store/backend';
import * as api from '../store/teamApi';
import InviteQR from './InviteQR';

const ROLES = ['owner', 'editor', 'viewer'];

function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

// Team / workspace management: switch between your workspaces, manage the active
// one (rename/delete/leave), its members (roles/remove), and invitations
// (email + shareable link + QR).
export default function WorkspaceSheet({ visible, onClose }) {
  const insets = useSafeAreaInsets();
  const { activateWorkspace, refreshWorkspace } = useTasks();
  const cfg = serverConfig();
  const activeId = cfg && cfg.tenantId;
  const activeRole = (cfg && cfg.role) || 'viewer';
  const isOwner = activeRole === 'owner';
  const canInvite = activeRole === 'owner' || activeRole === 'editor';

  const [workspaces, setWorkspaces] = useState([]);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [err, setErr] = useState(null);
  const [newName, setNewName] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [inviteEmail, setInviteEmail] = useState('');
  const [lastInvite, setLastInvite] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setWorkspaces(await api.listWorkspaces());
    } catch (e) { setErr(String(e.message || e)); }
    if (activeId) {
      try { setMembers(await api.listMembers(activeId)); } catch { setMembers([]); }
      if (canInvite) { try { setInvites(await api.listInvites(activeId)); } catch { setInvites([]); } }
      else setInvites([]);
    }
  }, [activeId, canInvite]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const run = async (fn) => {
    setErr(null);
    try { await fn(); await load(); } catch (e) { setErr(String(e.message || e)); }
  };

  const doCreate = () =>
    run(async () => {
      const t = await api.createWorkspace(newName.trim());
      setNewName('');
      await activateWorkspace(t);
    });
  const doSwitch = (t) => run(async () => { await activateWorkspace(t); });
  const doRename = () =>
    run(async () => {
      const name = (prompt ? prompt('New workspace name', cfg.tenantName) : '') || '';
      if (name.trim()) await api.renameWorkspace(activeId, name.trim());
    });
  const doDelete = () =>
    run(async () => {
      await api.deleteWorkspace(activeId);
      const list = await api.listWorkspaces();
      if (list[0]) await activateWorkspace(list[0]);
      else await refreshWorkspace();
    });
  const doLeave = () =>
    run(async () => {
      await api.leaveWorkspace(activeId);
      const list = await api.listWorkspaces();
      if (list[0]) await activateWorkspace(list[0]);
      else await refreshWorkspace();
    });
  const doRole = (userId, role) => run(() => api.changeMemberRole(activeId, userId, role));
  const doRemove = (userId) => run(() => api.removeMember(activeId, userId));
  const doInvite = () =>
    run(async () => {
      const inv = await api.createInvite(activeId, inviteRole, inviteEmail.trim());
      setLastInvite(inv);
      setInviteEmail('');
    });
  const doRevoke = (code) => run(async () => {
    await api.revokeInvite(code);
    if (lastInvite && lastInvite.code === code) setLastInvite(null);
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Text style={styles.title}>Workspaces & team</Text>
          <Pressable hitSlop={10} onPress={onClose} style={styles.close}>
            <Ionicons name="close" size={24} color={colors.textSecondary} />
          </Pressable>
        </View>

        {!cfg ? (
          <View style={styles.pad}>
            <Text style={styles.hint}>Sign in (Settings → Sync) to manage workspaces and invite teammates.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scroll}>
            {err && <Text style={styles.err}>{err}</Text>}

            {/* --- Your workspaces --- */}
            <Text style={styles.section}>Your workspaces</Text>
            {workspaces.map((w) => (
              <Pressable key={w.id} onPress={() => w.id !== activeId && doSwitch(w)} style={styles.row}>
                <Ionicons
                  name={w.id === activeId ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={w.id === activeId ? colors.accent : colors.textTertiary}
                />
                <Text style={[styles.rowText, w.id === activeId && { fontWeight: '700' }]}>{w.name}</Text>
                <View style={styles.roleTag}><Text style={styles.roleTagText}>{w.role}</Text></View>
              </Pressable>
            ))}
            <View style={styles.inlineForm}>
              <TextInput
                style={styles.input}
                value={newName}
                onChangeText={setNewName}
                placeholder="New workspace name"
                placeholderTextColor={colors.placeholder}
              />
              <Btn label="Create" onPress={doCreate} disabled={!newName.trim()} />
            </View>

            {/* --- Active workspace actions --- */}
            <Text style={styles.section}>{cfg.tenantName || 'Active workspace'}</Text>
            <View style={styles.actionsRow}>
              {isOwner && <Btn label="Rename" icon="pencil" variant="outline" onPress={doRename} />}
              {isOwner && <Btn label="Delete" icon="trash" variant="danger" onPress={doDelete} />}
              <Btn label="Leave" icon="exit-outline" variant="outline" onPress={doLeave} />
            </View>

            {/* --- Members --- */}
            <Text style={styles.section}>Members ({members.length})</Text>
            {members.map((m) => (
              <View key={m.userId} style={styles.row}>
                <View style={[styles.avatar, { backgroundColor: colorFor(m.userId) }]}>
                  <Text style={styles.avatarText}>{initial(m)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText}>{m.displayName || m.username}</Text>
                  {!!m.email && <Text style={styles.sub}>{m.email}</Text>}
                </View>
                {isOwner ? (
                  <RolePicker role={m.role} onChange={(r) => doRole(m.userId, r)} />
                ) : (
                  <View style={styles.roleTag}><Text style={styles.roleTagText}>{m.role}</Text></View>
                )}
                {isOwner && (
                  <Pressable hitSlop={8} onPress={() => doRemove(m.userId)} style={{ marginLeft: spacing.sm }}>
                    <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
                  </Pressable>
                )}
              </View>
            ))}

            {/* --- Invitations --- */}
            {canInvite && (
              <>
                <Text style={styles.section}>Invite people</Text>
                <View style={styles.inlineForm}>
                  <RolePicker role={inviteRole} onChange={setInviteRole} owner={isOwner} />
                </View>
                <View style={styles.inlineForm}>
                  <TextInput
                    style={styles.input}
                    value={inviteEmail}
                    onChangeText={setInviteEmail}
                    placeholder="Email to send an invite (optional)"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <Btn label={inviteEmail.trim() ? 'Send' : 'Create link'} icon="paper-plane" onPress={doInvite} />
                </View>

                {lastInvite && (
                  <View style={styles.inviteCard}>
                    <Text style={styles.inviteHeading}>
                      Invitation as {lastInvite.role}
                      {lastInvite.emailed ? ` · emailed to ${lastInvite.email}` : ''}
                    </Text>
                    <View style={styles.linkRow}>
                      <Text style={styles.link} numberOfLines={1}>{lastInvite.url}</Text>
                      <Pressable hitSlop={8} onPress={() => copyText(lastInvite.url)}>
                        <Ionicons name="copy-outline" size={18} color={colors.accent} />
                      </Pressable>
                    </View>
                    <InviteQR value={lastInvite.url} size={190} />
                    <Text style={styles.sub}>Scan the code or share the link. Anyone who opens it joins as {lastInvite.role}.</Text>
                  </View>
                )}

                {invites.length > 0 && (
                  <>
                    <Text style={styles.subsection}>Active invitations</Text>
                    {invites.map((inv) => (
                      <View key={inv.code} style={styles.row}>
                        <Ionicons name="link" size={16} color={colors.textTertiary} />
                        <Text style={[styles.rowText, { flex: 1 }]} numberOfLines={1}>
                          {inv.email || 'link'} · {inv.role}
                        </Text>
                        <Pressable hitSlop={8} onPress={() => copyText(inv.url)} style={{ marginRight: spacing.md }}>
                          <Ionicons name="copy-outline" size={18} color={colors.accent} />
                        </Pressable>
                        <Pressable hitSlop={8} onPress={() => doRevoke(inv.code)}>
                          <Text style={styles.revoke}>Revoke</Text>
                        </Pressable>
                      </View>
                    ))}
                  </>
                )}
              </>
            )}
            <View style={{ height: insets.bottom + 40 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function RolePicker({ role, onChange, owner = true }) {
  const options = owner ? ROLES : ['editor', 'viewer'];
  return (
    <View style={styles.rolePicker}>
      {options.map((r) => (
        <Pressable key={r} onPress={() => onChange(r)} style={[styles.roleOpt, role === r && styles.roleOptActive]}>
          <Text style={[styles.roleOptText, role === r && styles.roleOptTextActive]}>{r}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Btn({ label, icon, onPress, variant = 'primary', disabled }) {
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? colors.overdue : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? '#fff' : colors.accent;
  const border = variant === 'outline' ? colors.separatorStrong : variant === 'danger' ? colors.overdue : 'transparent';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.btn, { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.4 : 1 }]}
    >
      {icon && <Ionicons name={icon} size={15} color={fg} />}
      <Text style={[styles.btnText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

function initial(m) {
  return String(m.displayName || m.username || '?').trim().charAt(0).toUpperCase();
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 60% 45%)`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  title: { ...typography.title, color: colors.text },
  close: { padding: 4 },
  pad: { padding: spacing.lg },
  scroll: { padding: spacing.lg },
  hint: { ...typography.body, color: colors.textSecondary },
  err: { ...typography.caption, color: colors.overdue, marginBottom: spacing.md },
  section: { ...typography.caption, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.xl, marginBottom: spacing.sm },
  subsection: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.lg, marginBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  rowText: { ...typography.body, color: colors.text, flexShrink: 1 },
  sub: { ...typography.caption, color: colors.textTertiary },
  roleTag: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 },
  roleTagText: { ...typography.caption, color: colors.textSecondary },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  input: { flex: 1, ...typography.body, color: colors.text, backgroundColor: colors.surfaceMuted, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: Platform.OS === 'web' ? 10 : 8 },
  actionsRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: 8 },
  btnText: { ...typography.body, fontWeight: '600' },
  avatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  rolePicker: { flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 2 },
  roleOpt: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.sm },
  roleOptActive: { backgroundColor: colors.accent },
  roleOptText: { ...typography.caption, color: colors.textSecondary, textTransform: 'capitalize' },
  roleOptTextActive: { color: '#fff', fontWeight: '700' },
  inviteCard: { marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, gap: spacing.sm },
  inviteHeading: { ...typography.body, fontWeight: '600', color: colors.text },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  link: { flex: 1, ...typography.caption, color: colors.accent },
  revoke: { ...typography.caption, color: colors.overdue, fontWeight: '600' },
});
