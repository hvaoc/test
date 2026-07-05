import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import { serverConfig } from '../store/backend';
import { openAuth } from '../store/authModal';
import * as api from '../store/teamApi';

// Reads (and clears) an ?invite=CODE from the URL once, so a refresh doesn't
// re-trigger the join.
function readInviteCode() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    const u = new URL(window.location.href);
    const code = u.searchParams.get('invite');
    if (code) {
      u.searchParams.delete('invite');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
    return code;
  } catch {
    return null;
  }
}

// When the app is opened from an invitation link, this banner walks the user
// through joining: preview the workspace, then accept (auto once signed in).
export default function JoinInvite() {
  const { activateWorkspace } = useTasks();
  const [code] = useState(readInviteCode);
  const [info, setInfo] = useState(null);
  const [state, setState] = useState('pending'); // pending | joining | done | error | dismissed
  const [msg, setMsg] = useState(null);
  const cfg = serverConfig();
  const signedIn = !!cfg;

  // Preview the invite (needs a server; only when signed in).
  useEffect(() => {
    if (!code || !signedIn) return;
    api.inviteInfo(code).then(setInfo).catch(() => {});
  }, [code, signedIn]);

  // Auto-accept once we have a session.
  useEffect(() => {
    if (!code || !signedIn || state !== 'pending') return;
    setState('joining');
    api
      .acceptInvite(code)
      .then(async (t) => {
        await activateWorkspace(t);
        setMsg(`Joined “${t.name}”`);
        setState('done');
      })
      .catch((e) => {
        setMsg(String(e.message || e));
        setState('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, signedIn]);

  if (!code || state === 'dismissed') return null;

  let icon = 'mail-open-outline';
  let text = 'You have a workspace invitation.';
  let tone = colors.accent;
  if (!signedIn) text = info ? `Invited to “${info.workspace}” — sign in (Settings → Sync) to join.` : 'You’re invited to a workspace — sign in (Settings → Sync) to join.';
  else if (state === 'joining') text = 'Joining workspace…';
  else if (state === 'done') { icon = 'checkmark-circle'; tone = colors.today; text = msg; }
  else if (state === 'error') { icon = 'alert-circle'; tone = colors.overdue; text = `Couldn’t join: ${msg}`; }

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.banner, { borderColor: tone }]}>
        <Ionicons name={icon} size={18} color={tone} />
        <Text style={styles.text} numberOfLines={2}>{text}</Text>
        {!signedIn && (
          <Pressable
            onPress={() => openAuth('login', { reason: info ? `Join “${info.workspace}”` : 'Sign in to join the workspace' })}
            style={styles.cta}
          >
            <Text style={styles.ctaText}>Sign in</Text>
          </Pressable>
        )}
        <Pressable hitSlop={8} onPress={() => setState('dismissed')}>
          <Ionicons name="close" size={18} color={colors.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 12 : 44,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 520,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    backgroundColor: colors.overlay || colors.surfaceMuted,
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 18px rgba(0,0,0,0.18)' } : null),
  },
  text: { ...typography.body, color: colors.text, flexShrink: 1 },
  cta: { backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 6 },
  ctaText: { ...typography.caption, color: '#fff', fontWeight: '700' },
});
