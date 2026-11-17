package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteCommandTest {
    @Test fun parsesRotate() {
        assertEquals(RemoteCommand.Rotate(RotationMode.PORTRAIT), RemoteCommand.from("rotate", "portrait", ""))
        assertEquals(RemoteCommand.Rotate(RotationMode.LANDSCAPE), RemoteCommand.from("rotate", " Landscape ", null))
        assertEquals(RemoteCommand.Rotate(RotationMode.AUTO), RemoteCommand.from("rotate", "auto", ""))
        assertNull(RemoteCommand.from("rotate", "upside-down", ""))
        assertNull(RemoteCommand.from("rotate", "", ""))
        assertNull(RemoteCommand.from("rotate", null, null))
    }

    @Test fun parsesNav() {
        assertEquals(RemoteCommand.Nav(NavAction.BACK), RemoteCommand.from("nav", "", "back"))
        assertEquals(RemoteCommand.Nav(NavAction.HOME), RemoteCommand.from("nav", null, "HOME"))
        assertEquals(RemoteCommand.Nav(NavAction.RECENTS), RemoteCommand.from("nav", "", "recents"))
        assertNull(RemoteCommand.from("nav", "", "power"))
    }

    @Test fun otherTypesAreNotOurs() {
        // quality/keyframe continuam com o transporte (RtcClient/UsbStreamServer)
        assertNull(RemoteCommand.from("quality", "", ""))
        assertNull(RemoteCommand.from("keyframe", "", ""))
        assertNull(RemoteCommand.from("", "portrait", "back"))
        assertNull(RemoteCommand.from(null, "portrait", "back"))
    }

    @Test fun navMapsToGlobalActions() {
        // AccessibilityService.GLOBAL_ACTION_BACK/HOME/RECENTS
        assertEquals(1, NavAction.BACK.globalAction)
        assertEquals(2, NavAction.HOME.globalAction)
        assertEquals(3, NavAction.RECENTS.globalAction)
    }

    @Test fun overlayOrientation() {
        // ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT = 12, USER_LANDSCAPE = 11; auto = sem overlay
        assertEquals(12, RotationPolicy.overlayOrientation(RotationMode.PORTRAIT))
        assertEquals(11, RotationPolicy.overlayOrientation(RotationMode.LANDSCAPE))
        assertNull(RotationPolicy.overlayOrientation(RotationMode.AUTO))
    }

    @Test fun settingsFallbackRotation() {
        // Surface.ROTATION_0 = 0, ROTATION_90 = 1; auto = devolve ao sensor
        assertEquals(0, RotationPolicy.userRotation(RotationMode.PORTRAIT))
        assertEquals(1, RotationPolicy.userRotation(RotationMode.LANDSCAPE))
        assertNull(RotationPolicy.userRotation(RotationMode.AUTO))
    }

    @Test fun statusJson() {
        assertEquals(
            "{\"type\":\"status\",\"scope\":\"rotate\",\"ok\":true,\"text\":\"Tela em retrato\"}",
            RemoteCommand.statusJson("rotate", true, "Tela em retrato")
        )
        assertEquals(
            "{\"type\":\"status\",\"scope\":\"nav\",\"ok\":false,\"text\":\"O Android recusou \\\"Voltar\\\".\\nlinha\\\\ \\u0001\"}",
            RemoteCommand.statusJson("nav", false, "O Android recusou \"Voltar\".\nlinha\\ \u0001")
        )
    }
}
