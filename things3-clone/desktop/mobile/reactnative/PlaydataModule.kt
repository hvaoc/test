// Android React Native native module bridging JS ↔ the gomobile-bound Go engine
// (playdata.aar built by ../../build-mobile.sh). Exposes the same three async
// methods the JS backend bridge (src/store/backend.js) looks for on
// NativeModules.Playdata.
//
// Setup (bare / prebuilt RN Android project):
//   1. Copy mobile-bind/android/playdata.aar → android/app/libs/
//   2. build.gradle:  implementation files('libs/playdata.aar')
//   3. Register PlaydataPackage() in your ReactNativeHost's getPackages().
//
// The gomobile package name is `mobile`; gomobile generates a Java class
// `mobile.Mobile` with static methods Open/LoadSnapshot/SaveSnapshot/Sync.
package com.things3clone.playdata

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import mobile.Mobile

class PlaydataModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "Playdata"

    // Called once at app start with the app's writable files dir.
    @ReactMethod
    fun open(promise: Promise) {
        try {
            Mobile.open(reactApplicationContext.filesDir.absolutePath)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("open_error", e)
        }
    }

    @ReactMethod
    fun loadSnapshot(promise: Promise) {
        try {
            promise.resolve(Mobile.loadSnapshot())
        } catch (e: Exception) {
            promise.reject("load_error", e)
        }
    }

    @ReactMethod
    fun saveSnapshot(state: String, promise: Promise) {
        try {
            Mobile.saveSnapshot(state)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("save_error", e)
        }
    }

    @ReactMethod
    fun sync(promise: Promise) {
        try {
            promise.resolve(Mobile.sync())
        } catch (e: Exception) {
            promise.reject("sync_error", e)
        }
    }
}
