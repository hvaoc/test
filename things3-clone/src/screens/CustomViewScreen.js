import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '../theme';
import { useTasks } from '../store/TasksContext';
import { runQuery, describeQuery } from '../store/query';
import StickyTaskSections from '../components/StickyTaskSections';
import TaskDetailModal from '../components/TaskDetailModal';
import SidebarToggle from '../components/SidebarToggle';
import QueryBuilderSheet from '../components/QueryBuilderSheet';

// Renders a saved Custom View — a user-defined query — as a list. The header
// carries an Edit affordance that reopens the query builder; deleting from
// there returns to the default list.
export default function CustomViewScreen({
  navigation,
  viewId,
  embedded,
  onToggleSidebar,
  sidebarVisible,
}) {
  const insets = useSafeAreaInsets();
  const { state, updateCustomView, deleteCustomView } = useTasks();
  const view = state.customViews.find((v) => v.id === viewId);
  const [editOpen, setEditOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState(null);

  const results = useMemo(
    () => (view ? runQuery(state, view.query) : []),
    [state, view]
  );
  const sections = useMemo(
    () => [{ key: 'results', title: null, data: results, showProject: true }],
    [results]
  );

  if (!view) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.navBar}>
          {embedded ? null : (
            <Pressable hitSlop={10} onPress={() => navigation.goBack()} style={styles.back}>
              <Ionicons name="chevron-back" size={26} color={colors.accent} />
            </Pressable>
          )}
        </View>
        <View style={styles.hint}>
          <Text style={styles.hintText}>This view no longer exists.</Text>
        </View>
      </View>
    );
  }

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
        <Pressable style={styles.editBtn} onPress={() => setEditOpen(true)}>
          <Ionicons name="options-outline" size={15} color={colors.textSecondary} />
          <Text style={styles.editText}>Edit</Text>
        </Pressable>
      </View>

      <View style={styles.titleRow}>
        <Ionicons name={view.icon} size={24} color={view.color} style={{ marginRight: 8 }} />
        <Text style={[styles.screenTitle, { color: view.color }]} numberOfLines={1}>{view.name}</Text>
      </View>
      <Text style={styles.subtitle} numberOfLines={1}>{describeQuery(view.query)}</Text>

      {results.length === 0 ? (
        <View style={styles.hint}>
          <Ionicons name="funnel-outline" size={40} color={colors.separatorStrong} />
          <Text style={styles.hintText}>Nothing matches this view yet.</Text>
        </View>
      ) : (
        <>
          <Text style={styles.count}>{results.length} to-do{results.length === 1 ? '' : 's'}</Text>
          <StickyTaskSections
            sections={sections}
            showProject
            onOpenTask={setOpenTaskId}
            contentPadding={{ paddingBottom: insets.bottom + 100 }}
          />
        </>
      )}

      <QueryBuilderSheet
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        mode="view"
        availableTags={state.tags}
        initialQuery={view.query}
        initialMeta={{ name: view.name, icon: view.icon, color: view.color }}
        onSubmit={(query, meta) =>
          updateCustomView(view.id, { query, name: meta.name, icon: meta.icon, color: meta.color })
        }
        onDelete={() => {
          deleteCustomView(view.id);
          navigation.goBack();
        }}
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
  navBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 44 },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  editText: { ...typography.subhead, color: colors.textSecondary, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  screenTitle: { ...typography.largeTitle, flexShrink: 1 },
  subtitle: { ...typography.subhead, color: colors.textTertiary, paddingHorizontal: spacing.lg, marginTop: 2, marginBottom: spacing.sm },
  count: { ...typography.subhead, color: colors.textTertiary, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  hint: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  hintText: { ...typography.body, color: colors.textTertiary, textAlign: 'center', maxWidth: 320 },
});
