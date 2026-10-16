import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

val repoRoot = rootProject.projectDir.parentFile
val stageDir = layout.buildDirectory.dir("stage").get().asFile

// Stage the UNMODIFIED backend/ package (+ an empty backend/__init__.py) and the
// built frontend/dist (as an Android asset) without touching the repo.
val stageBackend = tasks.register<Sync>("stageBackend") {
    into(stageDir.resolve("python"))
    from(repoRoot.resolve("backend")) {
        into("backend")
        exclude("**/__pycache__/**", "**/*.pyc")
    }
    // backend/app/__init__.py does `from .main import app` (imports fastapi);
    // the staged copy gets an empty one and no main.py. Repo files untouched.
    exclude("**/main.py")
    doLast {
        stageDir.resolve("python/backend/__init__.py").writeText("")
        stageDir.resolve("python/backend/app/__init__.py").writeText("")
    }
}
val stageFrontend = tasks.register<Sync>("stageFrontend") {
    from(repoRoot.resolve("frontend/dist"))
    into(stageDir.resolve("assets/frontend-dist"))
}

// arm64 ffmpeg + ffprobe. Both are real PIE executables in the AAR's jniLibs
// (`libffmpeg.so` / `libffprobe.so`), plus `libffmpeg.zip.so`, a zip of the
// shared libraries they need at runtime. Pulled in as a normal dependency so
// AGP packages its jni/ dir; transitives dropped (androidx would clash with
// android.useAndroidX=false, and the AAR's classes are never loaded).
val nativeSupportSource by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}

// Libraries the ffmpeg executables need but the ffmpeg payload does not ship.
// (The AAR assumes them to be reachable from the same LD_LIBRARY_PATH as the
// youtubedl-android python payload; here we stage them next to the natives.)
val supportLibs = listOf(
    "libc++_shared.so",
    "libexpat.so.1",
    "libcrypto.so.3",
    "libandroid-support.so",
    "libandroid-posix-semaphore.so",
)

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1") {
        isTransitive = false
    }
    // The same publisher's `library` AAR carries those libs inside its
    // libpython.zip.so payload.
    nativeSupportSource("io.github.junkfood02.youtubedl-android:library:0.18.1@aar")
}

// Extract supportLibs from the nested payload into the assets that get copied
// next to the extracted ffmpeg payload at runtime. (Not jniLibs: they would be
// dropped, AGP only packages native libs whose name ends in .so, and the
// dynamic linker looks these up by their exact soname.)
val supportAssetsDir = stageDir.resolve("assets/ffmpeg-support")
val stageNativeSupportLibs = tasks.register("stageNativeSupportLibs") {
    inputs.files(nativeSupportSource)
    inputs.property("supportLibs", supportLibs)
    outputs.dir(supportAssetsDir)
    doLast {
        supportAssetsDir.deleteRecursively()
        supportAssetsDir.mkdirs()
        val aar = nativeSupportSource.singleFile
        val payload = File(temporaryDir, "libpython.zip.so")
        ZipFile(aar).use { outer ->
            val entry = outer.getEntry("jni/arm64-v8a/libpython.zip.so")
                ?: error("libpython.zip.so not found in ${aar.name}")
            outer.getInputStream(entry).use { i -> payload.outputStream().use { o -> i.copyTo(o) } }
        }
        ZipFile(payload).use { zf ->
            for (name in supportLibs) {
                // Payload entries can be stored symlinks; follow a few hops.
                var cur = name
                var data: ByteArray? = null
                for (hop in 0 until 5) {
                    val e = zf.getEntry("usr/lib/$cur") ?: break
                    val bytes = zf.getInputStream(e).use { it.readBytes() }
                    val target = if (bytes.size <= 128) String(bytes, Charsets.UTF_8).trim() else ""
                    if (target.isNotEmpty() && zf.getEntry("usr/lib/$target") != null) {
                        cur = target
                    } else {
                        data = bytes
                        break
                    }
                }
                val bytes = data ?: error("could not resolve $name in libpython.zip.so")
                File(supportAssetsDir, name).writeBytes(bytes)
                logger.lifecycle("staged $name (${bytes.size} bytes) from ${aar.name}")
            }
        }
    }
}

android {
    namespace = "dev.spitifo.spike"
    compileSdk = 34
    buildToolsVersion = "34.0.0"
    defaultConfig {
        applicationId = "dev.spitifo.spike"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1-spike"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    sourceSets["main"].assets.srcDir(stageDir.resolve("assets"))
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // Extract jniLibs at install time so the ffmpeg/ffprobe executables are
    // real files in applicationInfo.nativeLibraryDir and can be exec'd.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
}

chaquopy {
    defaultConfig {
        version = "3.12"
        buildPython("C:/Users/Alejandro/AppData/Local/Programs/Python/Python312/python.exe")
        pip {
            install("starlette")
            install("uvicorn")
            install("httpx")
            install("mutagen")
            install("python-multipart")
            install("yt-dlp")
        }
    }
    sourceSets {
        getByName("main") { srcDir(stageDir.resolve("python")) }
    }
}

tasks.configureEach {
    if (name == "preBuild" || (name.startsWith("merge") &&
                (name.endsWith("PythonSources") || name.endsWith("Assets"))) ||
        name.startsWith("generate") && name.endsWith("PythonRequirements")) {
        dependsOn(stageBackend, stageFrontend, stageNativeSupportLibs)
    }
}
