import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import { runQuery, describeQuery, isEmptyQuery, emptyQuery } from '../store/query';
import StickyTaskSections from '../components/StickyTaskSections';
import TaskDetailModal from '../components/TaskDetailModal';
import SidebarToggle from '../components/SidebarToggle';
import QueryBuilderSheet from '../components/QueryBuilderSheet';

// Search results screen. Scope can be universal ('all') or restricted to an
// Area / Project (passed in via route.params.scope). The text box does fuzzy
// title matching; the "Filters" sheet adds structured conditions (label,
// priority, date, deadline, time, duration). A configured search can be saved
// as a Custom View in one tap.
export default function SearchScreen({
  navigation,
  scope,
  scopeTitle,
  embedded,
  onToggleSidebar,
  sidebarVisible,
}) {
  const insets = useSafeAreaInsets();
  const { state, addCustomView } = useTasks();
  const [query, setQuery] = useState(() => emptyQuery({ scope: scope || { type: 'all', id: null } }));
  const [filtersOpen, setFiltersOpen] = useState(false);

  const results = useMemo(() => runQuery(state, query), [state, query]);
  const empty = isEmptyQuery(query);
  const activeConds = (query.conditions || []).filter((c) => c && c.field && c.op).length;

  const sections = useMemo(
    () => [{ key: 'results', title: null, data: results, showProject: true }],
    [results]
  );

  const [openTaskId, setOpenTaskId] = useState(null);

  const saveAsView = () => {
    addCustomView({
      name: (query.text || '').trim() || 'Saved Search',
      icon: 'bookmark-outline',
      color: colors.accent,
      query: { ...query, text: query.text || '' },
    });
  };

  const placeholder = scope && scope.id ? `Search in ${scopeTitle || 'here'}` : 'Search all to-dos';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.navBar}>
        {embedded ? (
          sidebarVisible ? (
            <View style={styles.back} />
          ) : (
            <SidebarToggle onPress={onToggleSidebar} color={colors.accent} style={styles.back} />
          )
        ) : (
          <Pressable hitSlop={10} onPress={() => navigation.goBack()} style={styles.back}>
            <Ionicons name="chevron-back" size={26} color={colors.accent} />
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        {!empty && (
          <Pressable style={styles.saveView} onPress={saveAsView}>
            <Ionicons name="bookmark-outline" size={15} color={colors.accent} />
            <Text style={styles.saveViewText}>Save as View</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.searchArea}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            value={query.text}
            onChangeText={(t) => setQuery((q) => ({ ...q, text: t }))}
            placeholder={placeholder}
            placeholderTextColor={colors.placeholder}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.text ? (
            <Pressable hitSlop={8} onPress={() => setQuery((q) => ({ ...q, text: '' }))}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </Pressable>
          ) : null}
          <Pressable style={styles.filterBtn} onPress={() => setFiltersOpen(true)}>
            <Ionicons name="options-outline" size={16} color={activeConds ? colors.accent : colors.textSecondary} />
            <Text style={[styles.filterBtnText, activeConds && { color: colors.accent }]}>
              Filters{activeConds ? ` · ${activeConds}` : ''}
            </Text>
          </Pressable>
        </View>
        {(scope && scope.id) || activeConds ? (
          <Text style={styles.summary} numberOfLines={1}>
            {scope && scope.id ? `${scopeTitle} · ` : ''}
            {activeConds ? describeQuery({ ...query, text: '' }) : 'All to-dos'}
          </Text>
        ) : null}
      </View>

      {empty ? (
        <View style={styles.hint}>
          <Ionicons name="search-outline" size={40} color={colors.separatorStrong} />
          <Text style={styles.hintText}>Search by title, or add filters for label, priority, date, deadline, time or duration.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.hint}>
          <Ionicons name="sad-outline" size={40} color={colors.separatorStrong} />
          <Text style={styles.hintText}>No to-dos match.</Text>
        </View>
      ) : (
        <>
          <Text style={styles.count}>{results.length} result{results.length === 1 ? '' : 's'}</Text>
          <StickyTaskSections
            sections={sections}
            showProject
            onOpenTask={setOpenTaskId}
            contentPadding={{ paddingBottom: insets.bottom + 100 }}
          />
        </>
      )}

      <QueryBuilderSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        mode="search"
        availableTags={state.tags}
        initialQuery={query}
        onSubmit={(q) => setQuery((prev) => ({ ...q, scope: prev.scope }))}
      />

      <TaskDetailModal
        visible={!!openTaskId}
        taskId={openTaskId}
        onClose={() => setOpenTaskId(null)}
        onOpenTask={setOpenTaskId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    height: 44,
  },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  saveView: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  saveViewText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },

  searchArea: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : 4,
  },
  searchInput: { flex: 1, ...typography.title, color: colors.text, paddingVertical: 6, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.sm },
  filterBtnText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  summary: { ...typography.subhead, color: colors.textTertiary, marginTop: spacing.sm, marginLeft: 2 },

  count: { ...typography.subhead, color: colors.textTertiary, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  hint: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  hintText: { ...typography.body, color: colors.textTertiary, textAlign: 'center', maxWidth: 320 },
});
