import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  TextInput,
  Platform,
  Modal,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius } from '../theme';
import { SMART_LISTS, SMART_LIST_MAP } from '../store/constants';
import { useTasks } from '../store/TasksContext';
import { counts, selectProjectTasks, isOpen } from '../store/selectors';
import { selectionKey } from '../navigation/responsive';
import NewListSheet from '../components/NewListSheet';
import SettingsSheet from '../components/SettingsSheet';
import QueryBuilderSheet from '../components/QueryBuilderSheet';
import { emptyQuery } from '../store/query';
import ProgressPie from '../components/ProgressPie';
import DropTarget from '../components/DropTarget';
import ReorderableSmartLists from '../components/ReorderableSmartLists';
import SidebarToggle from '../components/SidebarToggle';
import { useDrag, SIDEBAR_ZONE_KEY } from '../store/DragContext';

// The Things sidebar / home: smart lists at the top, then your Areas and
// Projects. Tapping any entry drills into the matching list.
//
// `embedded` + `selectedKey` are passed by the two-pane SplitView (iPad / web /
// desktop): the sidebar stays mounted and highlights the active row instead of
// pushing a new screen. On phones both are undefined and it behaves as a stack.
export default function HomeScreen({ navigation, selectedKey, embedded, onToggleSidebar }) {
  const insets = useSafeAreaInsets();
  const { state, setSetting, addCustomView, reorderProjects } = useTasks();
  const [sheet, setSheet] = useState(false);
  const [newViewOpen, setNewViewOpen] = useState(false);
  // When the New List sheet is opened from an Area's "+", pre-file the project
  // into that area.
  const [sheetAreaId, setSheetAreaId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Account popover pinned to the profile row at the sidebar bottom. We measure
  // the row so the menu pops UP anchored to its top-left corner.
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileAnchor, setProfileAnchor] = useState(null);
  const profileRef = useRef(null);
  const openProfileMenu = () => {
    const node = profileRef.current;
    if (node && node.measureInWindow) {
      node.measureInWindow((x, y, width) => {
        setProfileAnchor({ x, y, width });
        setProfileOpen(true);
      });
    } else {
      setProfileOpen(true);
    }
  };
  // Collapsed areas (by id) — hides their projects in the sidebar.
  const [collapsedAreas, setCollapsedAreas] = useState(() => new Set());
  const toggleArea = (id) =>
    setCollapsedAreas((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const openNewList = (areaId = null) => {
    setSheetAreaId(areaId);
    setSheet(true);
  };

  // Register the whole sidebar as a drag "zone" so a task drag can tell when
  // the pointer is anywhere over the sidebar (not just over a drop target).
  const drag = useDrag();
  const sidebarRef = useRef(null);
  useEffect(() => {
    if (!drag || !embedded) return undefined;
    drag.register(SIDEBAR_ZONE_KEY, sidebarRef, { kind: 'zone' });
    return () => drag.unregister(SIDEBAR_ZONE_KEY);
  }, [drag, embedded]);

  const badge = useMemo(() => counts(state.tasks), [state.tasks]);

  // Smart lists split into pinned (Inbox on top; Logbook + Trash on the bottom)
  // and a reorderable middle group. The stored order is reconciled with the
  // current set so new lists (e.g. Overdue) appear and stale ids drop out.
  const PINNED = new Set(['inbox', 'logbook', 'trash']);
  const reorderableIds = useMemo(() => {
    const valid = SMART_LISTS.filter((l) => !PINNED.has(l.id)).map((l) => l.id);
    const stored = (state.settings?.smartListOrder || []).filter((id) => valid.includes(id));
    return [...stored, ...valid.filter((id) => !stored.includes(id))];
  }, [state.settings?.smartListOrder]);

  const smartRow = (id) => {
    const list = SMART_LIST_MAP[id];
    if (!list) return null;
    const row = (
      <SidebarRow
        icon={list.icon}
        color={list.color}
        outline={list.outline}
        title={list.title}
        badge={badge[list.id]}
        selected={selectedKey === `list:${list.id}`}
        onPress={() => navigation.navigate('List', { listId: list.id, title: list.title })}
      />
    );
    const droppable = id === 'inbox' || id === 'today';
    return droppable ? (
      <DropTarget key={id} targetKey={`list:${id}`} meta={{ kind: 'list', id }}>
        {row}
      </DropTarget>
    ) : (
      <React.Fragment key={id}>{row}</React.Fragment>
    );
  };

  // Manual sidebar order within an area/group (drag-to-reorder writes `order`).
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

  // Projects grouped under their area, plus any area-less projects.
  const looseProjects = state.projects
    .filter((p) => !p.areaId && p.status === 'open')
    .sort(byOrder);

  const projectStats = (projectId) => {
    const tasks = selectProjectTasks(state.tasks, projectId);
    return { done: tasks.filter((t) => !isOpen(t)).length, total: tasks.length };
  };

  return (
    <View
      ref={sidebarRef}
      collapsable={false}
      style={[
        styles.container,
        // Two-tone master/detail: a light-gray sidebar against the white detail
        // pane. Only when always-visible (iPad / web / desktop); phones stay white.
        embedded && styles.containerEmbedded,
        { paddingTop: insets.top + spacing.sm },
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.appTitle}>Things</Text>
        <View style={styles.headerActions}>
          {/* New List — always available, so a new/empty install can create its
              first Area or Project (the sheet has a Project/Area toggle). */}
          <Pressable
            hitSlop={8}
            onPress={() => openNewList(null)}
            style={({ hovered, pressed }) => [styles.headerBtn, (hovered || pressed) && styles.rowHover]}
          >
            <Ionicons name="add" size={22} color={colors.sidebarTextSecondary} />
          </Pressable>
          {onToggleSidebar && <SidebarToggle onPress={onToggleSidebar} color={colors.sidebarTextSecondary} />}
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Global search — opens the search screen scoped to everything. */}
        <View style={styles.section}>
          <SidebarRow
            icon="search"
            color={colors.sidebarTextSecondary}
            outline
            title="Search"
            selected={selectedKey === 'search'}
            onPress={() =>
              navigation.navigate('List', {
                search: true,
                scope: { type: 'all', id: null },
                title: 'Search',
              })
            }
          />
        </View>

        {/* Smart lists. Inbox is pinned on top, Logbook + Trash pinned at the
            bottom; the middle group (Today/Upcoming/Overdue/Anytime/Someday) is
            drag-reorderable within this zone. Only Inbox and Today accept
            dropped tasks. */}
        <View style={styles.section}>
          {smartRow('inbox')}
          <ReorderableSmartLists
            ids={reorderableIds}
            renderRow={smartRow}
            onReorder={(next) => setSetting('smartListOrder', next)}
          />
          {smartRow('logbook')}
          {smartRow('trash')}
        </View>

        {/* Areas with their projects. The header carries a "+" (add a project
            into this area) and a chevron to collapse/expand its projects. */}
        {state.areas.map((area) => (
          <AreaSection
            key={area.id}
            area={area}
            projects={state.projects
              .filter((p) => p.areaId === area.id && p.status === 'open')
              .sort(byOrder)}
            collapsed={collapsedAreas.has(area.id)}
            selectedKey={selectedKey}
            projectStats={projectStats}
            onOpenArea={() =>
              navigation.navigate('List', { areaId: area.id, title: area.name })
            }
            onAddProject={() => openNewList(area.id)}
            onToggle={() => toggleArea(area.id)}
            onOpenProject={(p) =>
              navigation.navigate('List', { projectId: p.id, title: p.name })
            }
            onReorderProjects={reorderProjects}
          />
        ))}

        {/* Loose projects — drag to reorder within the group. */}
        {looseProjects.length > 0 && (
          <View style={styles.section}>
            <ReorderableSmartLists
              ids={looseProjects.map((p) => p.id)}
              renderRow={(id) => {
                const p = looseProjects.find((x) => x.id === id);
                if (!p) return null;
                return (
                  <DropTarget
                    targetKey={`project:${id}`}
                    meta={{ kind: 'project', id, areaId: p.areaId }}
                  >
                    <ProjectRow
                      project={p}
                      stats={projectStats(id)}
                      selected={selectedKey === `project:${id}`}
                      onPress={() =>
                        navigation.navigate('List', { projectId: id, title: p.name })
                      }
                    />
                  </DropTarget>
                );
              }}
              onReorder={reorderProjects}
            />
          </View>
        )}

        {/* Custom Views — user-defined saved queries. A "+" adds a new one. */}
        <View style={styles.section}>
          <View
            onPointerEnter={() => {}}
            style={styles.areaHeader}
          >
            <View style={styles.areaHeaderMain}>
              <Text style={styles.areaTitle}>Views</Text>
            </View>
            <Pressable hitSlop={6} style={styles.areaBtn} onPress={() => setNewViewOpen(true)}>
              <Ionicons name="add" size={18} color={colors.sidebarTextSecondary} />
            </Pressable>
          </View>
          {(state.customViews || []).map((v) => (
            <SidebarRow
              key={v.id}
              icon={v.icon}
              color={v.color}
              outline
              title={v.name}
              selected={selectedKey === `view:${v.id}`}
              onPress={() =>
                navigation.navigate('List', { viewId: v.id, title: v.name })
              }
            />
          ))}
        </View>
      </ScrollView>

      {/* Persistent profile row, pinned to the bottom. Tapping it opens the
          account popover (Settings for now; room to grow). */}
      <Pressable
        ref={profileRef}
        onPress={openProfileMenu}
        style={({ pressed, hovered }) => [
          styles.profileRow,
          { paddingBottom: insets.bottom + spacing.sm },
          hovered && styles.rowHover,
          pressed && styles.rowPressed,
        ]}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>H</Text>
        </View>
        <Text style={styles.profileName} numberOfLines={1}>
          Havoc <Text style={styles.profilePlan}>· Max</Text>
        </Text>
        <Ionicons name="chevron-up" size={16} color={colors.sidebarTextSecondary} />
      </Pressable>

      <Modal
        visible={profileOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileOpen(false)}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setProfileOpen(false)}>
          <Pressable
            onPress={(e) => e?.stopPropagation?.()}
            style={[
              styles.profileMenu,
              profileAnchor && {
                position: 'absolute',
                left: profileAnchor.x,
                bottom: Dimensions.get('window').height - profileAnchor.y + 6,
                minWidth: profileAnchor.width,
              },
            ]}
          >
            <Text style={styles.menuEmail} numberOfLines={1}>havk.co@gmail.com</Text>
            <View style={styles.menuDivider} />
            <Pressable
              style={({ hovered, pressed }) => [
                styles.menuItem,
                (hovered || pressed) && styles.menuItemActive,
              ]}
              onPress={() => {
                setProfileOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Ionicons name="settings-outline" size={18} color={colors.sidebarText} />
              <Text style={styles.menuItemText}>Settings</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <NewListSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        navigation={navigation}
        initialAreaId={sheetAreaId}
      />
      <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <QueryBuilderSheet
        visible={newViewOpen}
        onClose={() => setNewViewOpen(false)}
        mode="view"
        availableTags={state.tags}
        initialQuery={emptyQuery()}
        onSubmit={(query, meta) => {
          addCustomView({ name: meta.name, icon: meta.icon, color: meta.color, query });
        }}
      />
    </View>
  );
}

// One Area header (row-wide hover highlight) plus its projects. Hover is tracked
// with local state on a plain View — NOT an outer Pressable — so the row doesn't
// become a spurious focusable/pointer no-op, and onPointerEnter/Leave don't
// bubble, so hovering the inner +/chevron buttons keeps the whole row lit.
function AreaSection({
  area,
  projects,
  collapsed,
  selectedKey,
  projectStats,
  onOpenArea,
  onAddProject,
  onToggle,
  onOpenProject,
  onReorderProjects,
}) {
  const [hovered, setHovered] = useState(false);
  const selected = selectedKey === `area:${area.id}`;
  return (
    <View style={styles.section}>
      <View
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        style={[
          styles.areaHeader,
          selected && styles.rowSelected,
          hovered && !selected && styles.rowHover,
        ]}
      >
        <Pressable style={styles.areaHeaderMain} onPress={onOpenArea}>
          {area.emoji ? (
            <Text style={styles.areaEmoji}>{area.emoji}</Text>
          ) : (
            <Ionicons name="cube-outline" size={16} color={area.color} />
          )}
          <Text style={styles.areaTitle} numberOfLines={1}>{area.name}</Text>
        </Pressable>
        <Pressable hitSlop={6} style={styles.areaBtn} onPress={onAddProject}>
          <Ionicons name="add" size={18} color={colors.sidebarTextSecondary} />
        </Pressable>
        <Pressable hitSlop={6} style={styles.areaBtn} onPress={onToggle}>
          <Ionicons
            name="chevron-down"
            size={16}
            color={colors.sidebarTextSecondary}
            style={{ transform: [{ rotate: collapsed ? '-90deg' : '0deg' }] }}
          />
        </Pressable>
      </View>
      {!collapsed && projects.length > 0 && (
        <ReorderableSmartLists
          ids={projects.map((p) => p.id)}
          renderRow={(id) => {
            const p = projects.find((x) => x.id === id);
            if (!p) return null;
            return (
              <DropTarget
                targetKey={`project:${id}`}
                meta={{ kind: 'project', id, areaId: p.areaId }}
              >
                <ProjectRow
                  project={p}
                  stats={projectStats(id)}
                  selected={selectedKey === `project:${id}`}
                  onPress={() => onOpenProject(p)}
                />
              </DropTarget>
            );
          }}
          onReorder={onReorderProjects}
        />
      )}
    </View>
  );
}

function SidebarRow({ icon, color, title, badge, onPress, selected, outline }) {
  return (
    <Pressable
      style={({ pressed, hovered }) => [
        styles.row,
        selected && styles.rowSelected,
        hovered && !selected && styles.rowHover,
        pressed && !selected && styles.rowPressed,
      ]}
      onPress={onPress}
    >
      <View style={[styles.iconWrap, !outline && { backgroundColor: color }]}>
        <Ionicons name={icon} size={outline ? 20 : 15} color={outline ? color : colors.white} />
      </View>
      <Text style={styles.rowTitle}>{title}</Text>
      {badge > 0 && <Text style={styles.badge}>{badge}</Text>}
    </Pressable>
  );
}

function ProjectRow({ project, stats, onPress, selected }) {
  const { done, total } = stats;
  return (
    <Pressable
      style={({ pressed, hovered }) => [
        styles.row,
        selected && styles.rowSelected,
        hovered && !selected && styles.rowHover,
        pressed && !selected && styles.rowPressed,
      ]}
      onPress={onPress}
    >
      {/* Emoji as the icon if the project has one; otherwise a "#" glyph. */}
      {project.emoji ? (
        <Text style={styles.projEmoji}>{project.emoji}</Text>
      ) : (
        <Text style={[styles.projHash, { color: project.color }]}>#</Text>
      )}
      <Text style={styles.rowTitle} numberOfLines={1}>
        {project.name}
      </Text>
      {total > 0 && (
        <View style={styles.projProgress}>
          <Text style={styles.badgeMuted}>
            {done}/{total}
          </Text>
          <ProgressPie progress={total ? done / total : 0} color={project.color} size={14} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  containerEmbedded: { backgroundColor: colors.groupedBackground },
  scroll: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  appTitle: { ...typography.largeTitle, color: colors.sidebarText },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  section: {
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  rowPressed: { backgroundColor: colors.sidebarHover },
  // Subtle hover (web) — sidebar-tuned so it reads on dark colored sidebars too.
  rowHover: { backgroundColor: colors.sidebarHover },
  rowSelected: { backgroundColor: colors.sidebarSelected },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { flex: 1, ...typography.body, color: colors.sidebarText },
  badge: {
    ...typography.subhead,
    color: colors.sidebarTextSecondary,
    fontVariant: ['tabular-nums'],
  },
  badgeMuted: { ...typography.subhead, color: colors.sidebarTextTertiary, fontVariant: ['tabular-nums'] },
  // Emoji / hash icon column, sized like the smart-list icon so rows line up.
  projEmoji: { width: 26, textAlign: 'center', fontSize: 17 },
  projHash: { width: 26, textAlign: 'center', ...typography.body, fontWeight: '700' },
  projProgress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  areaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  areaHeaderMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  areaBtn: {
    padding: 2,
    marginLeft: 2,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  areaEmoji: { fontSize: 15, width: 16, textAlign: 'center' },
  areaTitle: {
    flex: 1,
    ...typography.subhead,
    fontWeight: '700',
    color: colors.sidebarTextSecondary,
    textTransform: 'none',
  },

  // Persistent profile row pinned to the sidebar bottom.
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sidebarSeparator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  profileName: { flex: 1, ...typography.body, color: colors.sidebarText, fontWeight: '600' },
  profilePlan: { color: colors.sidebarTextTertiary, fontWeight: '400' },

  // Account popover — anchored above the profile row, so it belongs to the
  // sidebar and uses the sidebar surface + text (matches whatever the sidebar is).
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' },
  profileMenu: {
    backgroundColor: colors.groupedBackground,
    borderRadius: radius.lg,
    paddingVertical: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.sidebarSeparator,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  menuEmail: {
    ...typography.caption,
    color: colors.sidebarTextTertiary,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.sidebarSeparator },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.xs,
    borderRadius: radius.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  menuItemActive: { backgroundColor: colors.sidebarSelected },
  menuItemText: { ...typography.body, color: colors.sidebarText },
});
