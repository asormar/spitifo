import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

val repoRoot = rootProject.projectDir.parentFile
val stageDir = layout.buildDirectory.dir("stage").get().asFile

/* --------------------------------------------------------------- buildPython
 * Chaquopy needs a desktop CPython of the same version as the target runtime
 * (3.12) to build the app's pip packages. It is machine-specific, so it is NOT
 * hardcoded: android/local.properties (or the SPITIFO_BUILD_PYTHON env var)
 * supplies it. local.properties is per-machine and gitignored. */
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.isFile) f.inputStream().use { load(it) }
}
val buildPythonExe: String = localProps.getProperty("spitifo.buildPython")
    ?: System.getenv("SPITIFO_BUILD_PYTHON")
    ?: throw GradleException(
        "Chaquopy needs a Python 3.12 interpreter to build the app's packages, " +
            "but none was configured.\n" +
            "Add this line to android/local.properties:\n" +
            "    spitifo.buildPython=C:/path/to/python.exe\n" +
            "or set the SPITIFO_BUILD_PYTHON environment variable to that path.")

/* ----------------------------------------------------------- staged sources
 * Everything the APK carries is staged under app/build/stage, so the
 * repositories' own trees (backend/, frontend/) stay untouched. */

// The backend/ package exactly as it is in the repo: Starlette, no FastAPI, no
// pydantic. Chaquopy imports it as `backend.app.main`.
//
// oauth_clients.json is excluded on purpose: it holds the *desktop* Google
// client, and Android signs in natively through the Identity Services
// AuthorizationClient (ADR 0002, section 3). Shipping the file would put a
// desktop secret in the APK for no reason.
val stageBackend = tasks.register<Sync>("stageBackend") {
    into(stageDir.resolve("python"))
    from(repoRoot.resolve("backend")) {
        into("backend")
        exclude("**/__pycache__/**", "**/*.pyc", "**/oauth_clients.json")
    }
}

// The compiled frontend, served by Starlette from SPITIFO_FRONTEND_DIST at
// runtime. It ships as an asset because the python source tree is not a real
// filesystem path inside the APK.
val frontendDist = repoRoot.resolve("frontend/dist")
val stageFrontend = tasks.register<Sync>("stageFrontend") {
    from(frontendDist)
    into(stageDir.resolve("assets/frontend-dist"))
    doFirst {
        val index = frontendDist.resolve("index.html")
        if (!index.isFile) {
            throw GradleException(
                "frontend/dist/index.html not found: the APK would ship without UI.\n" +
                    "Build the frontend first, or just use android/build.ps1, which does it for you:\n" +
                    "    cd frontend && npm ci && npm run build")
        }
    }
}

/* ------------------------------------------------------------------- ffmpeg
 * arm64 ffmpeg + ffprobe, from the youtubedl-android AAR that the spike
 * proved works. The AAR's jniLibs hold both binaries as real PIE executables
 * (`libffmpeg.so` / `libffprobe.so`) plus `libffmpeg.zip.so`, a zip of the
 * shared libraries they need at runtime.
 *
 * The AAR assumes those libraries are reachable next to the publisher's python
 * payload, which this app does not ship, so a second AAR (the same publisher's
 * `library`) is used as a plain source of five .so files that get staged as
 * assets and extracted next to ffmpeg's own libs. Transitives are dropped
 * everywhere: androidx would clash with android.useAndroidX=false, and none of
 * the AAR classes are ever loaded. */
val nativeSupportSource by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}

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
    nativeSupportSource("io.github.junkfood02.youtubedl-android:library:0.18.1@aar")
    // Google sign-in on Android goes through the Identity Services
    // AuthorizationClient (ADR 0002, section 3): the host asks for a
    // `drive.file` access token and pushes it into the embedded Python backend.
    // See src/main/kotlin/dev/spitifo/DriveAuth.kt (and DriveProbeActivity.kt,
    // the session 7 spike, in debug).
    implementation("com.google.android.gms:play-services-auth:21.2.0")
}

// Not jniLibs: AGP only packages native libs whose name ends in .so, and the
// dynamic linker looks these up by their exact soname. They ride along as
// assets and the app copies them into the ffmpeg lib dir at first run.
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

/* ------------------------------------------------------------------ release
 * assembleRelease signs with android/keystore.properties, which is
 * machine-specific and gitignored. Nothing here ever creates a keystore or
 * invents a password: without the file the release build fails and says how to
 * make one. Debug builds are unaffected. */
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps: Properties? = if (keystorePropsFile.isFile) {
    Properties().apply { keystorePropsFile.inputStream().use { load(it) } }
} else {
    null
}
val keystoreHelp = """
    android/keystore.properties is missing, so the release APK cannot be signed.
    Create a keystore (do not reuse anyone else's, and keep the password safe):

        keytool -genkeypair -v -keystore android/spitifo-release.jks -alias spitifo ^
            -keyalg RSA -keysize 2048 -validity 10000

    and write android/keystore.properties (storeFile is relative to android/):

        storeFile=spitifo-release.jks
        storePassword=<password>
        keyAlias=spitifo
        keyPassword=<password>
""".trimIndent()

val checkReleaseKeystore = tasks.register("checkReleaseKeystore") {
    doFirst {
        if (keystoreProps == null) throw GradleException(keystoreHelp)
    }
}

android {
    namespace = "dev.spitifo"
    compileSdk = 34
    // Only platform 34 + build-tools 34.0.0 are installed on the build PC (and
    // only they are needed): do not let AGP pull another one.
    buildToolsVersion = "34.0.0"

    defaultConfig {
        applicationId = "dev.spitifo"
        minSdk = 30          // Android 11: direct paths into the public Music folder work via FUSE
        targetSdk = 34
        versionCode = 100
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        create("release") {
            val p = keystoreProps
            if (p != null) {
                storeFile = rootProject.file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
            // Without keystore.properties the values stay unset and
            // checkReleaseKeystore is what fails the build, with a real message.
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets["main"].assets.srcDir(stageDir.resolve("assets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Extract jniLibs at install time: ffmpeg/ffprobe have to be real files in
    // applicationInfo.nativeLibraryDir so the app can exec them and symlink to
    // them. Compressed-in-APK natives cannot be exec'd.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

chaquopy {
    defaultConfig {
        version = "3.12"
        buildPython(buildPythonExe)
        pip {
            install("starlette==1.7.0")
            // Plain uvicorn: the [standard] extra pulls uvloop and httptools,
            // which are C extensions with no Android wheels.
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

// The staging tasks feed Chaquopy's python sources and the merged assets, so
// whatever the build actually packages is always freshly staged.
tasks.configureEach {
    if (name == "preBuild" ||
        (name.startsWith("merge") &&
            (name.endsWith("PythonSources") || name.endsWith("Assets"))) ||
        (name.startsWith("generate") && name.endsWith("PythonRequirements"))) {
        dependsOn(stageBackend, stageFrontend, stageNativeSupportLibs)
    }
    if (name == "validateSigningRelease" || name.startsWith("packageRelease") ||
        name.startsWith("assembleRelease") || name.startsWith("bundleRelease")) {
        dependsOn(checkReleaseKeystore)
    }
}
