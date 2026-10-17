// Plugin versions come from the Chaquopy spike (branch spike/android-chaquopy,
// commit 866eb6f), which proved this exact combination builds and runs on the
// phone. Do not bump without re-testing on the device.
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("com.chaquo.python") version "17.0.0" apply false
}
