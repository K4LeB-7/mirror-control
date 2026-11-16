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

## Modo USB (ADB) — pelo cabo, sem Wi-Fi, sem servidor e sem instalar nada no PC (app 0.2.0+)
O navegador fala ADB direto com o celular pelo cabo (WebUSB). Não passa pela rede, então firewall, Wi-Fi e
servidor de sinalização não importam. Precisa do **Google Chrome ou Microsoft Edge** no computador.

**Uma vez só (preparação do celular):**
1. Ative as *Opções do desenvolvedor*: *Configurações → Sobre o telefone* → toque 7× em **Número da versão**
   (Xiaomi/HyperOS: **Versão do SO**/"Versão MIUI").
2. *Configurações → Opções do desenvolvedor* (Xiaomi: *Configurações adicionais → Opções do desenvolvedor*) →
   ligue **Depuração USB**. (Os toques vêm do serviço de acessibilidade do app, não do ADB: a opção do Xiaomi
   "Depuração USB (configurações de segurança)" não é necessária.)
3. No Windows o driver **"Android ADB Interface"** precisa estar instalado (já está no seu PC). Sem ele o Chrome não
   lista o aparelho.

**Toda vez:**
1. Ligue o cabo USB **de dados**. Se o celular perguntar o modo USB, "Transferência de arquivos" ou "Só carregar" servem.
2. No app: **1. Ativar serviço de acessibilidade** (se ainda não estiver) → **Iniciar modo USB (ADB)** → aceite a
   captura de tela. O app mostra um **PIN de 6 dígitos** (muda a cada vez que o modo USB é iniciado).
3. No PC, **feche qualquer `adb` em execução** (Android Studio, scrcpy, Vysor, ferramentas da Xiaomi). Se você usa adb
   no terminal: `adb kill-server`. Só um programa por vez pode usar a interface ADB.
4. Abra https://mirror-control.vercel.app no Chrome/Edge, digite o PIN no cartão **Conectar por cabo USB (ADB)** e
   toque em **Conectar por USB (ADB)** → escolha o celular na janela do Chrome → **Conectar**.
5. Na 1ª vez, o celular pergunta **"Permitir depuração USB?"** com a impressão digital da chave do navegador: marque
   **Sempre permitir deste computador** e toque em **Permitir**. (A chave fica guardada neste navegador; outro
   navegador/perfil ou limpar os dados do site pede de novo.)
6. O vídeo aparece; clique nele para capturar o mouse (ESC solta). Teclas, mouse e mapeamento funcionam igual ao modo Wi-Fi.
Se o cabo for solto e recolocado, o site reconecta sozinho (com o app ainda em modo USB). Para voltar ao modo Wi-Fi/QR,
use **Sair do USB** no site; no app, iniciar o espelhamento normal encerra o modo USB (um modo por vez).

### Problemas comuns do modo USB
- **"Este navegador não tem WebUSB"**: use Chrome ou Edge no computador (Firefox, Safari e navegadores de celular não
  têm WebUSB). O site precisa estar em https:// (a Vercel já é).
- **A janela do Chrome não lista o celular**: cabo só de carga (troque), Depuração USB desligada, ou o driver "Android
  ADB Interface" ausente (Gerenciador de Dispositivos do Windows). Desconecte e reconecte o cabo.
- **"Interface em uso por outro programa… `adb kill-server`"**: o `adb.exe` do PC (ou Android Studio/scrcpy/Vysor)
  está segurando o celular. Feche-os ou rode `adb kill-server`; o site tenta de novo sozinho a cada 3 s. O adb volta a
  funcionar normalmente depois que você clicar em **Sair do USB** no site.
- **Fica em "Confirme Permitir depuração USB"**: desbloqueie a tela do celular e aceite o aviso. Se tocou em Negar,
  solte e recoloque o cabo. Se não aparece aviso nenhum: *Opções do desenvolvedor → Revogar autorizações de depuração
  USB* e conecte de novo.
- **"O app não está em modo USB"**: o ADB funcionou, mas o app não está escutando. Toque em **Iniciar modo USB (ADB)**
  no app (e aceite a captura). O site continua tentando sozinho.
- **"PIN errado"**: confira o PIN atual na tela do app (ele muda a cada início do modo USB). Após 5 erros seguidos o
  app bloqueia novas tentativas por 1 min (e o dobro a cada novo bloqueio).
- **Vídeo some ao bloquear a tela / após um tempo (Xiaomi/HyperOS)**: *Configurações → Apps → Mirror Control →
  Economia de bateria → Sem restrições* e ative **Início automático**. Mantenha a notificação "Mirror Control ativo".
- **Toques não funcionam, só vídeo**: serviço de acessibilidade desligado (passo 1 do app; no Android 13+ veja
  "configurações restritas" acima).
- **Imagem pesada/atrasada**: escolha 720p e/ou 30 fps no menu do site; use uma porta USB do próprio PC (não hub).

## Conexão por cabo USB via tethering (rede pelo cabo, modo WebRTC)
1. Cabo USB **de dados** entre celular e PC (o Windows já traz o driver de rede por cabo; nada a instalar).
2. Celular (Xiaomi/HyperOS): *Configurações → Conexão e compartilhamento → Ponto de acesso portátil → **Tethering USB***.
   Em outros aparelhos: *Rede e internet → Ponto de acesso e tethering → Tethering USB*.
3. Windows: se aparecer "Rede nova", escolha **Rede privada**.
4. No app, a linha **Cabo USB** mostra `rndis0 ✔ 192.168.42.x` quando o cabo foi reconhecido. Se mostrar
   "tethering desligado", reconecte o cabo e ative o tethering; "aguardando IP…" é normal por alguns segundos.
5. Abra o site, use o ID da sala e inicie o espelhamento. O WebRTC escolhe sozinho o caminho pelo cabo
   (candidatos `host` 192.168.42.x no Diagnóstico).
O tethering usa a internet do celular para o PC se o PC não tiver outra; para o espelhamento só é preciso o cabo
(a sinalização usa a internet de qualquer dos dois lados).

## IDs diferentes entre site e app
O site e o app precisam usar o **mesmo ID de sala**. No site há o campo "ID que já está no app" (botão **Usar este ID**),
e também dá para abrir `https://mirror-control.vercel.app/?room=SEU_ID`. No app, **Escanear QR** preenche o ID certo.
