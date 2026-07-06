// Native RecordStore adapter for Android — bridges the gomobile-bound Go record
// engine (RecordMobile.aar → mobile.Mobile, wrapping core/record) to JavaScript via
// an Expo module. Mirrors the iOS Swift module and the web adapter method-for-method,
// so the JS RecordStore port is identical per platform. Every method speaks JSON
// strings (the gomobile boundary); the JS side parses them. See docs/architecture-1m.md §5.

package expo.modules.recordnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import mobile.Mobile
import java.io.File

class RecordNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RecordNative")

    // open(name): resolve `name` inside the app's files dir and open the record DB.
    AsyncFunction("open") { name: String ->
      val dir = appContext.reactContext?.filesDir?.absolutePath
        ?: appContext.cacheDirectory.absolutePath
      val file = if (name.isEmpty()) "things-record.db" else name
      Mobile.recordOpen(File(dir, file).absolutePath)
      true
    }

    AsyncFunction("hasData") { -> Mobile.recordHasData() }
    AsyncFunction("hydrate") { tasksJSON: String -> Mobile.recordHydrate(tasksJSON); true }
    AsyncFunction("queryList") { listID: String, todayKey: String -> Mobile.recordQueryList(listID, todayKey) }
    AsyncFunction("queryTasks") { queryJSON: String -> Mobile.recordQueryTasks(queryJSON) }
    AsyncFunction("searchTasks") { text: String, queryJSON: String -> Mobile.recordSearchTasks(text, queryJSON) }
    AsyncFunction("countTasks") { queryJSON: String -> Mobile.recordCountTasks(queryJSON) }
    AsyncFunction("getTask") { id: String -> Mobile.recordGetTask(id) }
    AsyncFunction("createTask") { taskJSON: String -> Mobile.recordCreateTask(taskJSON) }
    AsyncFunction("toggleComplete") { id: String, completed: Boolean -> Mobile.recordToggleComplete(id, completed); true }
    AsyncFunction("moveTask") { id: String, beforeID: String, afterID: String -> Mobile.recordMoveTask(id, beforeID, afterID); true }
    AsyncFunction("setTaskField") { id: String, field: String, valueJSON: String -> Mobile.recordSetTaskField(id, field, valueJSON); true }
    AsyncFunction("deleteTask") { id: String -> Mobile.recordDeleteTask(id); true }
  }
}
