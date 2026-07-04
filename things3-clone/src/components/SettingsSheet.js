import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  Switch,
  Modal,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import { useIsWide } from '../navigation/responsive';
import { DATE_FORMATS, formatDayKey, todayKey } from '../utils/date';

// Curated IANA timezones ('' = the device's local zone).
const TIMEZONES = [
  { id: '', label: 'System default' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { id: 'America/Denver', label: 'Denver (MT)' },
  { id: 'America/Chicago', label: 'Chicago (CT)' },
  { id: 'America/New_York', label: 'New York (ET)' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Paris', label: 'Paris / Berlin' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

function zoneTime(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
  } catch {
    return '';
  }
}

// ---- Reusable content primitives -----------------------------------------

// A labelled preference row: title + hint on the left, a control on the right.
function Field({ label, hint, children, last }) {
  return (
    <View style={[styles.field, !last && styles.fieldBorder]}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <View style={styles.fieldControl}>{children}</View>
    </View>
  );
}

function Toggle({ value, onValueChange }) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ true: colors.accent, false: colors.separatorStrong }}
      ios_backgroundColor={colors.separatorStrong}
    />
  );
}

// A stateful toggle for the mock sections (not persisted).
function MockToggle({ label, hint, initial, last }) {
  const [on, setOn] = useState(!!initial);
  return (
    <Field label={label} hint={hint} last={last}>
      <Toggle value={on} onValueChange={setOn} />
    </Field>
  );
}

function Segment({ options, value, onChange }) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} style={[styles.segBtn, active && styles.segBtnActive]}>
            <Text style={[styles.segText, active && styles.segTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// A bordered option list with a checkmark on the selected row.
function OptionList({ options, value, onChange, rightOf }) {
  return (
    <View style={styles.optionList}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={String(o.value) || 'default'}
            onPress={() => onChange(o.value)}
            style={[styles.optionRow, active && styles.optionRowActive]}
          >
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{o.label}</Text>
            <View style={styles.optionRight}>
              {rightOf ? <Text style={styles.optionHint}>{rightOf(o)}</Text> : null}
              {active && <Ionicons name="checkmark" size={18} color={colors.accent} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function Btn({ label, icon, onPress, variant = 'default' }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, variant === 'primary' && styles.btnPrimary, variant === 'outline' && styles.btnOutline]}>
      <Text style={[styles.btnText, variant === 'primary' && styles.btnTextPrimary, variant === 'outline' && styles.btnTextOutline]}>{label}</Text>
      {icon ? <Ionicons name={icon} size={15} color={variant === 'primary' ? colors.white : variant === 'outline' ? colors.accent : colors.textSecondary} /> : null}
    </Pressable>
  );
}

function GroupTitle({ children, style }) {
  return <Text style={[styles.groupTitle, style]}>{children}</Text>;
}

// ---- Section content ------------------------------------------------------

function AccountSection() {
  return (
    <>
      <View style={styles.field}>
        <View style={styles.fieldLabelWrap}>
          <GroupTitle>Plan</GroupTitle>
          <Text style={styles.bigValue}>Free</Text>
        </View>
        <Btn label="Manage plan" />
      </View>
      <View style={styles.hr} />

      <GroupTitle>Photo</GroupTitle>
      <View style={[styles.avatar, { marginTop: spacing.sm }]}>
        <Text style={styles.avatarText}>N</Text>
      </View>

      <GroupTitle style={{ marginTop: spacing.lg }}>Name</GroupTitle>
      <Text style={styles.value}>Nomm</Text>

      <Text style={[styles.groupTitle, { marginTop: spacing.lg }]}>Email</Text>
      <Text style={styles.value}>you@example.com</Text>

      <View style={{ marginTop: spacing.lg }}>
        <Btn label="Manage account" icon="open-outline" />
      </View>
      <Text style={[styles.fieldHint, { marginTop: spacing.sm }]}>
        To keep your account details secure, we'll take you to the browser to make changes.
      </Text>

      <View style={styles.links}>
        <Text style={styles.link}>Terms</Text>
        <Text style={styles.linkDot}>·</Text>
        <Text style={styles.link}>Privacy</Text>
        <Text style={styles.linkDot}>·</Text>
        <Text style={styles.link}>Delete account</Text>
      </View>
    </>
  );
}

function GeneralSection({ settings, setSetting }) {
  const sampleKey = todayKey();
  return (
    <>
      <MockToggle initial label="Confirm before deleting" hint="Ask for confirmation before moving a to-do to the Trash." />
      <Field
        label="Show completed items"
        hint="Display finished to-dos inside their project. The Logbook always keeps them."
      >
        <Toggle value={settings.showCompleted} onValueChange={(v) => setSetting('showCompleted', v)} />
      </Field>
      <Field
        label="Center content"
        hint="Constrain lists and projects to a centered column instead of the full width."
        last
      >
        <Toggle value={settings.centeredContent} onValueChange={(v) => setSetting('centeredContent', v)} />
      </Field>

      <View style={styles.hr} />
      <GroupTitle>Date format</GroupTitle>
      <Text style={styles.fieldHint}>Used for the date headers in the Calendar Day view.</Text>
      <OptionList
        options={DATE_FORMATS.map((id) => ({ value: id, label: formatDayKey(sampleKey, id) }))}
        value={settings.dateFormat || 'weekday-long'}
        onChange={(v) => setSetting('dateFormat', v)}
      />

      <View style={styles.hr} />
      <GroupTitle>Time zone</GroupTitle>
      <Text style={styles.fieldHint}>
        Sets what counts as "now"/"today" — affects Today, relative dates, overdue, and the current-time line.
      </Text>
      <OptionList
        options={TIMEZONES.map((tz) => ({ value: tz.id, label: tz.label }))}
        value={settings.timezone || ''}
        onChange={(v) => setSetting('timezone', v)}
        rightOf={(o) => zoneTime(o.value)}
      />
    </>
  );
}

function CalendarsSection({ settings, setSetting }) {
  return (
    <>
      <Field label="Day starts at" hint="First hour shown in the Calendar Day and Week timelines.">
        <Segment
          options={[{ value: 0, label: '12 AM' }, { value: 6, label: '6 AM' }]}
          value={settings.dayStartHour ?? 0}
          onChange={(v) => setSetting('dayStartHour', v)}
        />
      </Field>
      <Field label="Show weekends" hint="Include Saturday and Sunday in the Calendar Week view." last>
        <Toggle value={settings.showWeekends} onValueChange={(v) => setSetting('showWeekends', v)} />
      </Field>

      <View style={styles.hr} />
      <GroupTitle>Calendar accounts</GroupTitle>
      <Text style={styles.fieldHint}>Show events from your calendars alongside your to-dos.</Text>
      <View style={[styles.integ, { marginTop: spacing.sm }]}>
        <View style={styles.integLeft}>
          <Ionicons name="calendar" size={20} color={colors.textSecondary} />
          <Text style={styles.integName}>Apple Calendar</Text>
        </View>
        <Btn label="Connect" variant="outline" />
      </View>
      <View style={styles.integ}>
        <View style={styles.integLeft}>
          <Ionicons name="logo-google" size={20} color={colors.textSecondary} />
          <Text style={styles.integName}>Google Calendar</Text>
        </View>
        <Btn label="Connect" variant="outline" />
      </View>
    </>
  );
}

function BackupsSection({ reset, onClose }) {
  return (
    <>
      <MockToggle initial label="Automatic backups" hint="Back up your data to the cloud every day." />
      <Field label="Last backup" hint="Backups are encrypted end-to-end." last>
        <Text style={styles.value}>Today, 9:41 AM</Text>
      </Field>
      <View style={styles.hr} />
      <GroupTitle>Sample data</GroupTitle>
      <Text style={styles.fieldHint}>
        This build always starts from the demo data; reloading resets it. Use this to reset without reloading.
      </Text>
      <View style={{ marginTop: spacing.md, alignItems: 'flex-start' }}>
        <Btn label="Reset to sample data" icon="refresh" variant="outline" onPress={() => { reset(); onClose(); }} />
      </View>
    </>
  );
}

function ThemeSection() {
  const [appearance, setAppearance] = useState('light');
  const [accent, setAccent] = useState(colors.accent);
  const swatches = [colors.accent, '#E91E8C', '#7C5CFF', '#0A84FF', '#34C759', '#FF9F0A'];
  return (
    <>
      <Field label="Appearance" hint="Prototype renders in Light; the others are placeholders.">
        <Segment
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]}
          value={appearance}
          onChange={setAppearance}
        />
      </Field>
      <View style={styles.field}>
        <View style={styles.fieldLabelWrap}>
          <Text style={styles.fieldLabel}>Accent color</Text>
          <Text style={styles.fieldHint}>Used for highlights, checks, and buttons.</Text>
        </View>
        <View style={styles.swatchRow}>
          {swatches.map((c) => (
            <Pressable key={c} onPress={() => setAccent(c)} style={[styles.swatch, { backgroundColor: c }, accent === c && styles.swatchActive]}>
              {accent === c && <Ionicons name="checkmark" size={14} color={colors.white} />}
            </Pressable>
          ))}
        </View>
      </View>
    </>
  );
}

function IntegrationsSection() {
  const items = [
    { icon: 'logo-slack', name: 'Slack', desc: 'Turn messages into to-dos.' },
    { icon: 'logo-github', name: 'GitHub', desc: 'Link issues and pull requests.' },
    { icon: 'mail-outline', name: 'Email to Inbox', desc: 'Forward emails to capture them.' },
    { icon: 'logo-figma', name: 'Figma', desc: 'Attach designs to tasks.' },
  ];
  return (
    <>
      {items.map((it, i) => (
        <View key={it.name} style={[styles.integ, i < items.length - 1 && styles.fieldBorder]}>
          <View style={styles.integLeft}>
            <Ionicons name={it.icon} size={22} color={colors.textSecondary} />
            <View>
              <Text style={styles.integName}>{it.name}</Text>
              <Text style={styles.fieldHint}>{it.desc}</Text>
            </View>
          </View>
          <Btn label="Connect" variant="outline" />
        </View>
      ))}
    </>
  );
}

// Lighter placeholder sections built from a few mock rows.
function MockSection({ rows, note }) {
  return (
    <>
      {rows.map((r, i) => (
        <MockToggle key={r.label} label={r.label} hint={r.hint} initial={r.initial} last={i === rows.length - 1} />
      ))}
      {note ? <Text style={[styles.fieldHint, { marginTop: spacing.md }]}>{note}</Text> : null}
    </>
  );
}

// ---- The two-panel settings modal ----------------------------------------

export default function SettingsSheet({ visible, onClose }) {
  const { state, setSetting, reset } = useTasks();
  const insets = useSafeAreaInsets();
  const isWide = useIsWide();
  const [active, setActive] = useState('account');
  const [query, setQuery] = useState('');
  // On narrow screens the nav and the section are separate views (master/detail).
  const [showNav, setShowNav] = useState(true);

  const settings = state.settings;

  const SECTIONS = useMemo(() => [
    { id: 'account', label: 'Account', icon: 'person-circle-outline', render: () => <AccountSection /> },
    { id: 'general', label: 'General', icon: 'options-outline', render: () => <GeneralSection settings={settings} setSetting={setSetting} /> },
    { id: 'desktop', label: 'Desktop', icon: 'desktop-outline', render: () => (
      <MockSection rows={[
        { label: 'Launch at login', hint: 'Open the app automatically when you sign in.', initial: true },
        { label: 'Keep in menu bar', hint: 'Show a quick-access icon in the menu bar.' },
        { label: 'Show dock badge', hint: 'Badge the app icon with your Today count.', initial: true },
      ]} />
    ) },
    { id: 'subscription', label: 'Subscription', icon: 'card-outline', render: () => (
      <>
        <View style={styles.planCard}>
          <Text style={styles.planName}>Free</Text>
          <Text style={styles.fieldHint}>Unlimited to-dos and projects. Upgrade for calendar sync, backups, and teams.</Text>
          <View style={{ marginTop: spacing.md, alignItems: 'flex-start' }}>
            <Btn label="Upgrade to Pro" variant="primary" />
          </View>
        </View>
      </>
    ) },
    { id: 'theme', label: 'Theme', icon: 'color-palette-outline', render: () => <ThemeSection /> },
    { id: 'sidebar', label: 'Sidebar', icon: 'browsers-outline', render: () => (
      <MockSection
        rows={[
          { label: 'Show item counts', hint: 'Display the number of to-dos next to each list.', initial: true },
          { label: 'Show project progress', hint: 'Show the little progress ring on projects.', initial: true },
        ]}
        note="Tip: drag the smart lists in the sidebar to reorder them."
      />
    ) },
    { id: 'quickadd', label: 'Quick Add', icon: 'add-circle-outline', render: () => (
      <MockSection rows={[
        { label: 'Global shortcut', hint: 'Capture a to-do from anywhere with ⌃Space.', initial: true },
        { label: 'Paste links as titles', hint: 'Fetch the page title when you paste a URL.' },
      ]} />
    ) },
    { id: 'productivity', label: 'Productivity', icon: 'trending-up-outline', render: () => (
      <MockSection rows={[
        { label: 'Daily goal', hint: 'Celebrate when you clear your Today list.', initial: true },
        { label: 'Track streaks', hint: 'Count consecutive days you finish everything.' },
      ]} />
    ) },
    { id: 'reminders', label: 'Reminders', icon: 'alarm-outline', render: () => (
      <MockSection rows={[
        { label: 'Default reminder', hint: 'Remind me at 9:00 AM on the due date.', initial: true },
        { label: 'Nudge overdue items', hint: 'A gentle daily reminder for anything overdue.' },
      ]} />
    ) },
    { id: 'notifications', label: 'Notifications', icon: 'notifications-outline', render: () => (
      <MockSection rows={[
        { label: 'Push notifications', hint: 'Reminders and shared-list updates.', initial: true },
        { label: 'Play a sound', initial: true },
        { label: 'Weekly review', hint: 'A Sunday summary of the week ahead.' },
      ]} />
    ) },
    { id: 'backups', label: 'Backups', icon: 'cloud-upload-outline', render: () => <BackupsSection reset={reset} onClose={onClose} /> },
    { id: 'integrations', label: 'Integrations', icon: 'extension-puzzle-outline', render: () => <IntegrationsSection /> },
    { id: 'calendars', label: 'Calendars', icon: 'calendar-outline', render: () => <CalendarsSection settings={settings} setSetting={setSetting} /> },
  ], [settings, setSetting, reset, onClose]);

  const filtered = query
    ? SECTIONS.filter((s) => s.label.toLowerCase().includes(query.toLowerCase()))
    : SECTIONS;
  const current = SECTIONS.find((s) => s.id === active) || SECTIONS[0];

  const openSection = (id) => {
    setActive(id);
    setShowNav(false);
  };

  const nav = (
    <View style={[styles.nav, isWide && styles.navWide]}>
      {isWide && <Text style={styles.navTitle}>Settings</Text>}
      <View style={styles.search}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search"
          placeholderTextColor={colors.placeholder}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <ScrollView style={styles.navList} showsVerticalScrollIndicator={false}>
        {filtered.map((s) => {
          const on = s.id === active;
          return (
            <Pressable key={s.id} onPress={() => openSection(s.id)} style={[styles.navItem, on && isWide && styles.navItemActive]}>
              <Ionicons name={s.icon} size={20} color={on ? colors.accent : colors.textSecondary} />
              <Text style={[styles.navLabel, on && isWide && styles.navLabelActive]}>{s.label}</Text>
              {!isWide && <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} style={{ marginLeft: 'auto' }} />}
            </Pressable>
          );
        })}
        {filtered.length === 0 && <Text style={styles.noResults}>No settings found</Text>}
      </ScrollView>
      <Pressable style={styles.addTeam} onPress={() => {}}>
        <Ionicons name="add" size={18} color={colors.textSecondary} />
        <Text style={styles.addTeamText}>Add team</Text>
      </Pressable>
    </View>
  );

  const detail = (
    <View style={styles.content}>
      <View style={styles.contentHeader}>
        {!isWide && (
          <Pressable hitSlop={8} onPress={() => setShowNav(true)} style={styles.back}>
            <Ionicons name="chevron-back" size={24} color={colors.accent} />
          </Pressable>
        )}
        <Text style={styles.contentTitle}>{current.label}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </Pressable>
      </View>
      <ScrollView style={styles.contentScroll} contentContainerStyle={styles.contentInner} showsVerticalScrollIndicator={false}>
        {current.render()}
      </ScrollView>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[
            styles.panel,
            isWide ? styles.panelWide : [styles.panelFull, { paddingTop: insets.top, paddingBottom: insets.bottom }],
          ]}
          onPress={() => {}}
        >
          {isWide ? (
            <>
              {nav}
              {detail}
            </>
          ) : showNav ? (
            <View style={styles.mobileNav}>
              <View style={styles.contentHeader}>
                <Text style={styles.contentTitle}>Settings</Text>
                <Pressable hitSlop={8} onPress={onClose} style={styles.close}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>
              {nav}
            </View>
          ) : (
            detail
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const NAV_W = 248;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'default' } : null),
  },
  panel: {
    backgroundColor: colors.background,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 24px 60px rgba(0,0,0,0.28)' },
      default: { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 40, shadowOffset: { width: 0, height: 20 }, elevation: 24 },
    }),
  },
  panelWide: {
    flexDirection: 'row',
    width: '90%',
    maxWidth: 1040,
    height: '86%',
    maxHeight: 780,
    borderRadius: 16,
  },
  panelFull: { width: '100%', height: '100%' },

  // --- Left nav ---
  nav: { flex: 1, backgroundColor: colors.groupedBackground, paddingHorizontal: spacing.md, paddingTop: spacing.lg },
  // Fixed-width sidebar column. Explicit flex trio (not `flex: 0`) so it fully
  // overrides the base `flex: 1` on web and never shrinks to its content.
  navWide: {
    width: NAV_W,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: NAV_W,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.separator,
  },
  mobileNav: { flex: 1, backgroundColor: colors.groupedBackground },
  navTitle: { ...typography.title, color: colors.text, paddingHorizontal: spacing.sm, marginBottom: spacing.md },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.separator,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 36,
    marginBottom: spacing.md,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  navList: { flex: 1 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
    borderRadius: radius.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  navItemActive: { backgroundColor: colors.accentSoft },
  navLabel: { ...typography.body, color: colors.text },
  navLabelActive: { color: colors.accent, fontWeight: '600' },
  noResults: { ...typography.subhead, color: colors.textTertiary, padding: spacing.md },
  addTeam: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addTeamText: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },

  // --- Right content ---
  content: { flex: 1, backgroundColor: colors.background },
  contentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    height: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  back: { marginLeft: -spacing.sm },
  contentTitle: { ...typography.title, color: colors.text, flex: 1 },
  close: { marginRight: -spacing.sm, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  contentScroll: { flex: 1 },
  contentInner: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, maxWidth: 720 },

  // --- Fields ---
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  fieldBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  fieldLabelWrap: { flex: 1 },
  fieldLabel: { ...typography.body, color: colors.text, fontWeight: '500' },
  fieldHint: { ...typography.subhead, color: colors.textTertiary, marginTop: 2 },
  fieldControl: { flexShrink: 0 },
  groupTitle: { ...typography.subhead, color: colors.textSecondary, fontWeight: '700', textTransform: 'none' },
  value: { ...typography.body, color: colors.text, marginTop: 4 },
  bigValue: { ...typography.title, color: colors.text, marginTop: 2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginVertical: spacing.lg },

  // --- Segment ---
  segment: { flexDirection: 'row', backgroundColor: colors.separator, borderRadius: 8, padding: 2, gap: 2 },
  segBtn: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: 6, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  segBtnActive: { backgroundColor: colors.background },
  segText: { ...typography.subhead, color: colors.textSecondary },
  segTextActive: { color: colors.text, fontWeight: '600' },

  // --- Option list ---
  optionList: { marginTop: spacing.md, gap: 4 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  optionRowActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionText: { ...typography.body, color: colors.text },
  optionTextActive: { color: colors.accent, fontWeight: '600' },
  optionRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionHint: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },

  // --- Buttons ---
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  btnText: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  btnPrimary: { backgroundColor: colors.accent },
  btnTextPrimary: { color: colors.white },
  btnOutline: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent },
  btnTextOutline: { color: colors.accent },

  // --- Account ---
  avatar: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: '#E91E8C', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontSize: 40, fontWeight: '700' },
  links: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl },
  link: { ...typography.subhead, color: colors.accent, textDecorationLine: 'underline' },
  linkDot: { ...typography.subhead, color: colors.textTertiary },

  // --- Integrations / plan ---
  integ: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md },
  integLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  integName: { ...typography.body, color: colors.text, fontWeight: '500' },
  planCard: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, borderRadius: radius.md, padding: spacing.lg },
  planName: { ...typography.title, color: colors.text, marginBottom: 4 },

  // --- Theme ---
  swatchRow: { flexDirection: 'row', gap: spacing.sm },
  swatch: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  swatchActive: { borderWidth: 2, borderColor: colors.text },
});
