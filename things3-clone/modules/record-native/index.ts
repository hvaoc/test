import { requireNativeModule } from 'expo-modules-core';

// The native RecordStore engine (gomobile core/record). iOS only; undefined on
// platforms where the module isn't linked.
export default requireNativeModule('RecordNative');
