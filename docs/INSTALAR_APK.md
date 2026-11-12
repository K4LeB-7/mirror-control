# Como baixar e instalar o APK

**Download direto (sempre a versão mais recente):**
https://github.com/K4LeB-7/mirror-control/releases/latest/download/mirror-control.apk

Todas as versões: https://github.com/K4LeB-7/mirror-control/releases

## Instalação no celular
1. Abra o link acima no navegador do celular e baixe `mirror-control.apk`.
2. Abra o arquivo baixado. Se o Android pedir, toque em **Configurações** e ative
   **Permitir desta fonte** para o navegador/gerenciador de arquivos.
3. Toque em **Instalar**. Se o Play Protect avisar "app não verificado", escolha **Instalar mesmo assim**
   (o APK é de teste, assinado com chave de debug).
4. Abra o **Mirror Control** → **1. Ativar serviço de acessibilidade** → ligar **Mirror Control**.
   - Android 13+: se o toggle estiver cinza ("configuração restrita"), vá em
     *Configurações → Apps → Mirror Control → ⋮ → Permitir configurações restritas* e tente de novo.
5. Abra o site https://mirror-control.vercel.app, escaneie o QR (ou digite o ID) → **2. Iniciar espelhamento**.

## Atualizar para uma versão nova
Baixe o APK novamente e instale por cima: não precisa desinstalar, e as configurações são mantidas
(a assinatura é sempre a mesma).

## Publicar uma nova versão (desenvolvedor)
```bash
cd android
# aumente versionCode/versionName em app/build.gradle.kts
gradle assembleDebug
gh release create v0.1.2 app/build/outputs/apk/debug/app-debug.apk#mirror-control.apk \
  --title "v0.1.2" --notes "Correções: ..."
```
