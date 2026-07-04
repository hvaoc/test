import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import HomeScreen from '../screens/HomeScreen';
import ListScreen from '../screens/ListScreen';
import { colors } from '../theme';
import { selectionKey } from './responsive';
import { DragProvider } from '../store/DragContext';

const SIDEBAR_WIDTH = 320;
const DEFAULT_SELECTION = { listId: 'today', title: 'Today' };

// Two-pane layout for iPad / web / desktop: the sidebar is always visible on
// the left and selecting an entry swaps the detail pane on the right — no push,
// no back button. The screens are reused as-is via a synthetic `navigation`
// object whose `navigate('List', params)` simply updates the active selection.
export default function SplitView() {
  const [selected, setSelected] = useState(DEFAULT_SELECTION);
  const [collapsed, setCollapsed] = useState(false);

  const select = (_screen, params) => setSelected(params);
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

  return (
    <DragProvider>
      <View style={styles.root}>
        {!collapsed && (
          <View style={styles.sidebar}>
            <HomeScreen
              navigation={sidebarNav}
              embedded
              selectedKey={key}
              onToggleSidebar={toggleSidebar}
            />
          </View>
        )}
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
  detail: { flex: 1, backgroundColor: colors.background },
});
