// Native RecordStore adapter for iOS — bridges the gomobile-bound Go record engine
// (RecordMobile.xcframework, wrapping core/record) to JavaScript via an Expo module.
// It exposes the same query API as the web adapter (public/record.worker.js), so the
// JS RecordStore port is identical per platform. Every method speaks JSON strings
// (the gomobile boundary); the JS side parses them. See docs/architecture-1m.md §5.

import ExpoModulesCore
import RecordMobile

public class RecordNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RecordNative")

    // open(name): resolves `name` inside the app's Documents directory and opens
    // the record DB there, so JS needn't compute a filesystem path.
    AsyncFunction("open") { (name: String) throws -> Bool in
      let docs = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first
        ?? NSTemporaryDirectory()
      let file = name.isEmpty ? "things-record.db" : name
      let path = (docs as NSString).appendingPathComponent(file)
      var err: NSError?
      let ok = MobileRecordOpen(path, &err)
      if let e = err { throw e }
      return ok
    }

    AsyncFunction("hasData") { () throws -> Bool in
      var err: NSError?
      var out: ObjCBool = false
      MobileRecordHasData(&out, &err)
      if let e = err { throw e }
      return out.boolValue
    }

    AsyncFunction("hydrate") { (tasksJSON: String) throws -> Bool in
      var err: NSError?
      let ok = MobileRecordHydrate(tasksJSON, &err)
      if let e = err { throw e }
      return ok
    }

    AsyncFunction("queryList") { (listID: String, todayKey: String) throws -> String in
      var err: NSError?
      let s = MobileRecordQueryList(listID, todayKey, &err)
      if let e = err { throw e }
      return s
    }

    AsyncFunction("queryTasks") { (queryJSON: String) throws -> String in
      var err: NSError?
      let s = MobileRecordQueryTasks(queryJSON, &err)
      if let e = err { throw e }
      return s
    }

    AsyncFunction("searchTasks") { (text: String, queryJSON: String) throws -> String in
      var err: NSError?
      let s = MobileRecordSearchTasks(text, queryJSON, &err)
      if let e = err { throw e }
      return s
    }

    AsyncFunction("countTasks") { (queryJSON: String) throws -> Int in
      var err: NSError?
      var out: Int = 0
      MobileRecordCountTasks(queryJSON, &out, &err)
      if let e = err { throw e }
      return out
    }

    AsyncFunction("getTask") { (id: String) throws -> String in
      var err: NSError?
      let s = MobileRecordGetTask(id, &err)
      if let e = err { throw e }
      return s
    }

    AsyncFunction("createTask") { (taskJSON: String) throws -> String in
      var err: NSError?
      let s = MobileRecordCreateTask(taskJSON, &err)
      if let e = err { throw e }
      return s
    }

    AsyncFunction("toggleComplete") { (id: String, completed: Bool) throws -> Bool in
      var err: NSError?
      let ok = MobileRecordToggleComplete(id, completed, &err)
      if let e = err { throw e }
      return ok
    }

    AsyncFunction("moveTask") { (id: String, beforeID: String, afterID: String) throws -> Bool in
      var err: NSError?
      let ok = MobileRecordMoveTask(id, beforeID, afterID, &err)
      if let e = err { throw e }
      return ok
    }

    AsyncFunction("setTaskField") { (id: String, field: String, valueJSON: String) throws -> Bool in
      var err: NSError?
      let ok = MobileRecordSetTaskField(id, field, valueJSON, &err)
      if let e = err { throw e }
      return ok
    }

    AsyncFunction("deleteTask") { (id: String) throws -> Bool in
      var err: NSError?
      let ok = MobileRecordDeleteTask(id, &err)
      if let e = err { throw e }
      return ok
    }
  }
}
