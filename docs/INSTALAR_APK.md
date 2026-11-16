# Como baixar e instalar o APK

**Download direto (sempre a versão mais recente):**
https://github.com/K4LeB-7/mirror-control/raw/main/apk/mirror-control.apk

O APK fica versionado em `apk/` (versão atual em `apk/version.json`); o histórico do Git guarda as versões anteriores.

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
cp app/build/outputs/apk/debug/app-debug.apk ../apk/mirror-control.apk
echo '{"version":"0.1.2","versionCode":3}' > ../apk/version.json
git add ../apk && git commit -m "APK 0.1.2" && git push
```
O link de download acima já serve a versão nova após o push.

## Problemas comuns
- **Acessibilidade bloqueada ("configurações restritas", Xiaomi/Android 13+):** toque no item bloqueado e confirme o aviso;
  depois *Configurações → Apps → Gerenciar apps → Mirror Control → ⋮ → Permitir configurações restritas*.
- **"Conteúdo oculto por compartilhamento de tela por segurança":** aviso do próprio Android (notificações e senhas
  ficam ocultas enquanto a tela é compartilhada). Não é erro do app.
- **Site sem vídeo:** o app mostra na tela principal em que etapa parou ("Sinalização conectada", "Oferta enviada",
  "Resposta recebida", "ICE: connected/failed…") e o site tem o painel **Diagnóstico da conexão**. Celular e notebook
  devem estar na **mesma rede Wi-Fi** (sem "isolamento de clientes"/rede de convidados); em redes diferentes é preciso um
  servidor TURN. Use o ID mostrado no site (um ID antigo não conecta).
- **Mapear teclas sem o celular:** botão **Mapear teclas e mouse** na tela inicial do site.

## Se ficar em "conectando" (firewall / rede)
O app e o site usam conexão direta (WebRTC/UDP) e, se ela for bloqueada, um servidor **TURN** de retransmissão
(por padrão o público Open Relay, só para teste; o tráfego segue criptografado). Para a conexão direta (mais rápida):
- Celular e notebook no **mesmo Wi-Fi**, sem rede de convidados nem "isolamento de clientes/AP isolation" no roteador;
- Desligue VPN no notebook e no celular; no Xiaomi, desligue "Wi-Fi+ dados móveis";
- No Windows, a rede deve estar como **Privada** e o Chrome/Edge permitido no Firewall (Segurança do Windows →
  Firewall → Permitir um aplicativo), ou como administrador:
  `netsh advfirewall firewall add rule name="Chrome WebRTC" dir=in action=allow program="C:\Program Files\Google\Chrome\Application\chrome.exe" protocol=UDP profile=any`
- Extensões que "bloqueiam vazamento de WebRTC" (uBlock/Privacy) impedem a conexão direta: desative-as neste site.
O painel **Diagnóstico da conexão** do site e o status do app mostram quantos candidatos de rede (host/srflx/relay)
foram achados; `relay=0` indica que o TURN não está acessível (rede bloqueando a porta 443/80).
Para uso sério, configure o seu TURN: variáveis `NEXT_PUBLIC_TURN_URL`, `NEXT_PUBLIC_TURN_USER`, `NEXT_PUBLIC_TURN_PASS` na Vercel.
