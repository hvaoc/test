// iOS React Native native module bridging JS ↔ the gomobile-bound Go engine
// (Playdata.xcframework built by ../../build-mobile.sh). Exposes the same three
// async methods the JS backend bridge (src/store/backend.js) looks for on
// NativeModules.Playdata.
//
// Setup (bare / prebuilt RN iOS project):
//   1. Drag mobile-bind/ios/Playdata.xcframework into the Xcode project
//      (Embed & Sign).
//   2. Add this file + the matching Playdata.m (below) to the target.
//   3. The gomobile package `mobile` is imported as the `Mobile` module; it
//      exposes MobileOpen / MobileLoadSnapshot / MobileSaveSnapshot / MobileSync.
//
// A companion Objective-C bridge (Playdata.m) registers the module with RN:
//
//   #import <React/RCTBridgeModule.h>
//   @interface RCT_EXTERN_MODULE(Playdata, NSObject)
//   RCT_EXTERN_METHOD(open:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
//   RCT_EXTERN_METHOD(loadSnapshot:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
//   RCT_EXTERN_METHOD(saveSnapshot:(NSString *)state resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
//   RCT_EXTERN_METHOD(sync:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
//   @end

import Foundation
import Mobile // the gomobile-generated framework

@objc(Playdata)
class Playdata: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func filesDir() -> String {
    let paths = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
    return paths.first ?? NSTemporaryDirectory()
  }

  @objc(open:rejecter:)
  func open(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      var err: NSError?
      MobileOpen(filesDir(), &err)
      if let err = err { reject("open_error", err.localizedDescription, err); return }
      resolve(nil)
    }
  }

  @objc(loadSnapshot:rejecter:)
  func loadSnapshot(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var err: NSError?
    let json = MobileLoadSnapshot(&err)
    if let err = err { reject("load_error", err.localizedDescription, err); return }
    resolve(json)
  }

  @objc(saveSnapshot:resolver:rejecter:)
  func saveSnapshot(_ state: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var err: NSError?
    MobileSaveSnapshot(state, &err)
    if let err = err { reject("save_error", err.localizedDescription, err); return }
    resolve(nil)
  }

  @objc(sync:rejecter:)
  func sync(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var err: NSError?
    let res = MobileSync(&err)
    if let err = err { reject("sync_error", err.localizedDescription, err); return }
    resolve(res)
  }
}
