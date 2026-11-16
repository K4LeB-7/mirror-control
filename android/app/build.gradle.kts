plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mirror.gamecontrol"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mirror.gamecontrol"
        minSdk = 26          // StrokeDescription.continueStroke (toques contínuos) exige API 26
        targetSdk = 34
        versionCode = 6
        versionName = "0.1.5"
    }

    // Keystore de debug fixa no repositório: todo APK futuro tem a mesma assinatura,
    // então o Android instala por cima (atualiza) sem pedir para desinstalar.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("io.github.webrtc-sdk:android:125.6422.07")   // pacote org.webrtc
    implementation("com.squareup.okhttp3:okhttp:4.12.0")          // WebSocket de sinalização (PeerServer)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0") // leitor de QR
}
