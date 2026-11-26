package com.mirror.gamecontrol

/**
 * Perfis de fluidez (app 0.3.3), escolhidos no site (CTRL `{"type":"input","profile":"balanced|smooth|eco"}`) e
 * aplicados em tempo de execução no [TouchPlanner]. Os números saíram das medições no modelo do AOSP
 * (MultiActionBenchTest; tabela em docs/INSTALAR_APK.md): só o que melhorou lá foi adotado.
 *
 * [frameMs] = duração de um quadro do display (1000 / taxa de atualização; 8 num painel de 120 Hz). O Android gera os
 * passos de um gesture a cada quadro, então a cadência dos dedos parados acompanha o display.
 *
 * Troca CPU x latência: cada gesture é uma chamada ao sistema (binder) + o cálculo dos passos; mais gestures/s =
 * mais CPU/bateria. "Máxima fluidez" renova os dedos segurados a cada quadro; "Equilibrado" a cada ~16 ms (como a
 * 0.3.2, mas com segmentos curtos: menos tempo com gesture em voo = menos espera para a próxima tecla); "Economia"
 * a cada 50 ms (o jogo fica até 50 ms sem MOVE de um dedo PARADO; movimentos e toques continuam saindo na hora).
 */
enum class FluidityProfile(val wire: String, val label: String) {
    BALANCED("balanced", "Equilibrado"),
    SMOOTH("smooth", "Máxima fluidez"),
    ECO("eco", "Economia");

    fun config(frameMs: Int): TouchPlanner.Config {
        val f = frameMs.toLong().coerceIn(4, 34)
        return when (this) {
            BALANCED -> TouchPlanner.Config(
                segmentMs = f,
                pressSegmentMs = 2,
                moveSegmentMs = 4,
                idleWait = true,
                finalMs = 2,
                holdPeriodMs = maxOf(16, f),
                holdSegmentMs = 2,
                minTapMs = 50,
            )
            SMOOTH -> TouchPlanner.Config(
                segmentMs = f,
                pressSegmentMs = 1,
                moveSegmentMs = 2,
                idleWait = true,
                finalMs = 1,
                holdPeriodMs = f,
                holdSegmentMs = 1,
                minTapMs = 40,
            )
            ECO -> TouchPlanner.Config(
                segmentMs = f,
                pressSegmentMs = 4,
                moveSegmentMs = 8,
                idleWait = true,
                finalMs = 4,
                holdPeriodMs = 50,
                holdSegmentMs = 4,
                minTapMs = 50,
            )
        }
    }

    companion object {
        fun fromWire(s: String?): FluidityProfile? = values().firstOrNull { it.wire == s }

        /** Duração de um quadro (ms, inteiro como o AOSP: `(int) (1000 / refreshRate)`). */
        fun frameMs(refreshHz: Float): Int = if (refreshHz >= 1f) (1000f / refreshHz).toInt().coerceAtLeast(1) else 16
    }
}
