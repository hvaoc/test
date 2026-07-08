import React, { useState, useEffect, useRef } from 'react';
import { View, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import HomeScreen from '../screens/HomeScreen';
import ListScreen from '../screens/ListScreen';
import { colors } from '../theme';
import { selectionKey } from './responsive';
import { DragProvider } from '../store/DragContext';

const SIDEBAR_WIDTH = 320;
const DEFAULT_SELECTION = { listId: 'today', title: 'Today' };

// Two-pane layout for iPad / web / desktop. In landscape (and on desktop) the
// sidebar sits inline to the left of the detail pane. On a tablet in PORTRAIT the
// two must never share the screen: the content pane takes the full width and the
// sidebar becomes a DRAWER that overlays it (with a scrim) — revealed by the
// SidebarToggle and dismissed by picking a list or tapping the scrim.
export default function SplitView() {
  const [selected, setSelected] = useState(DEFAULT_SELECTION);
  const { width, height } = useWindowDimensions();
  const isTouch = Platform.OS === 'ios' || Platform.OS === 'android';
  const drawer = isTouch && height >= width; // tablet portrait → overlay drawer

  // Start collapsed in drawer mode; re-sync only when the orientation actually
  // flips, so a manual toggle in between is respected.
  const [collapsed, setCollapsed] = useState(drawer);
  const prevDrawer = useRef(drawer);
  useEffect(() => {
    if (prevDrawer.current !== drawer) {
      setCollapsed(drawer);
      prevDrawer.current = drawer;
    }
  }, [drawer]);

  // Picking a list from the drawer closes it, so the content is shown alone.
  const select = (_screen, params) => {
    setSelected(params);
    if (drawer) setCollapsed(true);
  };
  const sidebarNav = { navigate: select, goBack: () => {}, setOptions: () => {} };
  // In the detail pane, "back" (e.g. after deleting a project) returns to the
  // default list rather than popping a stack that doesn't exist here.
  const detailNav = {
    navigate: select,
    goBack: () => setSelected(DEFAULT_SELECTION),
    setOptions: () => {},
  };

  const toggleSidebar = () => setCollapsed((c) => !c);
  const key = selectionKey(selected);

  const sidebar = (
    <View style={[styles.sidebar, drawer && styles.sidebarDrawer]}>
      <HomeScreen
        navigation={sidebarNav}
        embedded
        selectedKey={key}
        onToggleSidebar={toggleSidebar}
      />
    </View>
  );

  return (
    <DragProvider>
      <View style={styles.root}>
        {/* Landscape / desktop: sidebar inline, left of the detail. */}
        {!collapsed && !drawer && sidebar}

        <View style={styles.detail}>
          {/* Remount on selection change so per-list state (open task, scroll) resets. */}
          <ListScreen
            key={key}
            navigation={detailNav}
            route={{ params: selected }}
            embedded
            onToggleSidebar={toggleSidebar}
            sidebarVisible={!collapsed}
          />
        </View>

        {/* Portrait tablet: sidebar overlays the content as a drawer + scrim. */}
        {!collapsed && drawer && (
          <>
            <Pressable style={styles.scrim} onPress={() => setCollapsed(true)} />
            {sidebar}
          </>
        )}
      </View>
    </DragProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  sidebar: {
    width: SIDEBAR_WIDTH,
    backgroundColor: colors.groupedBackground,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.separatorStrong,
  },
  // Drawer variant: lifted out of the row flow so the detail fills the width,
  // pinned to the left over a scrim.
  sidebarDrawer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 20,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 2, height: 0 },
    elevation: 16,
  },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 10 },
  detail: { flex: 1, backgroundColor: colors.background },
});
