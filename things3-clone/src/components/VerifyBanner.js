import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { serverConfig, updateServerProfile } from '../store/backend';
import { verifyEmail } from '../store/teamApi';

function readVerifyCode() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    const u = new URL(window.location.href);
    const code = u.searchParams.get('verify');
    if (code) {
      u.searchParams.delete('verify');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
    return code;
  } catch {
    return null;
  }
}

// Handles ?verify=CODE from an email-verification link: confirms it against the
// server and shows a small banner.
export default function VerifyBanner() {
  const [code] = useState(readVerifyCode);
  const [state, setState] = useState('working'); // working | done | error | dismissed
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!code) return;
    const cfg = serverConfig();
    verifyEmail(code, cfg && cfg.url)
      .then(() => {
        updateServerProfile({ verified: true });
        setMsg('Email verified — you’re all set.');
        setState('done');
      })
      .catch((e) => {
        setMsg(String(e.message || e));
        setState('error');
      });
  }, [code]);

  if (!code || state === 'dismissed') return null;
  const tone = state === 'error' ? colors.overdue : colors.today;
  const icon = state === 'error' ? 'alert-circle' : state === 'done' ? 'checkmark-circle' : 'hourglass-outline';
  const text = state === 'working' ? 'Verifying your email…' : msg;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.banner, { borderColor: tone }]}>
        <Ionicons name={icon} size={18} color={tone} />
        <Text style={styles.text} numberOfLines={2}>{text}</Text>
        <Pressable hitSlop={8} onPress={() => setState('dismissed')}>
          <Ionicons name="close" size={18} color={colors.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: Platform.OS === 'web' ? 12 : 44, left: 0, right: 0, alignItems: 'center', zIndex: 1000 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: 520,
    marginHorizontal: spacing.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.lg, borderWidth: 1, backgroundColor: colors.overlay || colors.surfaceMuted,
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 18px rgba(0,0,0,0.18)' } : null),
  },
  text: { ...typography.body, color: colors.text, flexShrink: 1 },
});
