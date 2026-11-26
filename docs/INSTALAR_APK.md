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

## Usando o site (app e site 0.3.0+)
A página tem uma **barra no topo** (nunca sobre a imagem do celular), o **vídeo no centro** usando todo o espaço livre
e, quando você mapeia, um **painel à direita** (em janelas estreitas, embaixo). O vídeo continua ao vivo e clicável
com o painel aberto. A linha de baixo da barra mostra uma dica do modo atual ou a resposta do celular.

### Dois modos de mouse
| | **Mouse livre** (padrão ao conectar) | **Mouse travado** (para jogar) |
|---|---|---|
| Cursor | visível, sem Pointer Lock | some (Pointer Lock) |
| Botão esquerdo | toque/arrasto no ponto clicado | controle mapeado (padrão: Atirar) |
| Botão direito | **Voltar** do Android | controle mapeado (padrão: Mirar) |
| Roda | rola a tela (gera um swipe curto) | controle mapeado, se houver (Roda ↑/↓) |
| Movimento | — | câmera (dedo que desliza a partir da âncora "câmera") |
| Teclas mapeadas | funcionam (opção "Teclas ativas no modo livre") | funcionam |

- **F8** (configurável no painel → Opções) ou o botão **Travar mouse** alternam os modos. **Esc** sempre solta o mouse
  e volta ao livre; o site nunca trava de novo sozinho (clicar no vídeo no modo livre é só um toque).
- O selo **Mouse livre / Mouse travado** na barra mostra o modo e o atalho. Trocar de modo, perder o foco da janela ou
  girar a tela solta todos os dedos.
- Com o foco num campo de texto do site as teclas não viram toques. Depois do Esc o Chrome pede ~1 s antes de deixar
  travar de novo.

### Girar a tela e botões do Android
- **Retrato / Paisagem / Auto** na barra pedem ao celular para girar (Auto devolve ao sensor). O vídeo, a proporção e o
  layout de controles acompanham sozinhos, sem derrubar a conexão.
- Como o app gira: com o **serviço de acessibilidade** ativo, uma janela invisível de 1×1 pede a orientação ao Android
  (não precisa de nada além disso). Sem acessibilidade, o app usa **Modificar configurações do sistema** (botão
  **Permitir girar a tela pelo site** no app). Se nenhum dos dois estiver disponível, a barra do site explica o que
  ativar. Ao parar o espelhamento a rotação volta ao normal.
- **Limitação:** algumas ROMs (e tablets/telas dobráveis no Android 12L+ e 16) ignoram pedidos de orientação de
  janelas; nesses aparelhos use o botão de rotação do próprio celular. Apps/jogos que travam a própria orientação
  continuam mandando.
- **◁ Voltar / ○ Início / ▢ Recentes** na barra (e o botão direito no modo livre) usam a acessibilidade.

### Mapear teclas (perfis, retrato e paisagem)
- Na **primeira vez** que o vídeo aparece (e na primeira vez em cada orientação), o mapeador abre sozinho com um guia de
  3 passos. Depois, use **Mapear** na barra. **Concluir** fecha e salva (tudo fica salvo no navegador).
- **Perfis**: Novo, Duplicar, Renomear, Excluir, **Exportar** (baixa um .json), **Importar arquivo**, **Copiar** /
  **Colar** (JSON). Cada perfil tem um layout de **retrato** e outro de **paisagem**; o site usa o da orientação atual
  do vídeo. O mapeamento da versão anterior é migrado para a paisagem do perfil "Padrão".
- **Controles**: arraste no vídeo; ou selecione e use as **setas** (Shift = passo maior) ou **Definir posição clicando
  no vídeo**. **+ Botão** → clique no vídeo → aperte a tecla/botão do mouse.
- **Excluir controles (site 0.3.1+)**: TODOS podem ser excluídos, inclusive os pré-definidos (joystick WASD, câmera e
  os botões Atirar/Mirar/Pular/Agachar/Recarregar): **✕** ao lado do controle na lista, **Delete** com ele
  selecionado, ou **Excluir joystick/câmera/botão** no editor dele. Joystick excluído = WASD não toca nada; câmera
  excluída = o mouse travado não move a câmera. Cada exclusão aparece numa faixa com **Desfazer** (ou **Ctrl+Z** com o
  painel aberto; o histórico vale até recarregar a página).
  - **Limpar tudo**: deixa o layout desta orientação sem nenhum controle (começar do zero).
  - **+ Joystick** / **+ Câmera**: trazem de volta o que foi excluído, com as mesmas teclas e posição.
  - **Restaurar padrão**: volta o layout desta orientação ao padrão (também dá para desfazer).
  - Fica salvo no navegador: os pré-definidos excluídos não voltam sozinhos ao recarregar. Perfis antigos continuam
    iguais (nada é apagado na atualização).
- **Atalho por captura**: clique no atalho e aperte a tecla, o botão do mouse (esquerdo/meio/direito) ou gire a roda
  (Esc cancela). Atalhos repetidos (inclusive com F8/Esc) aparecem em amarelo. Botões do mouse só disparam controles
  com o mouse travado.
- **Tipo do botão**: Segurar (dedo fica enquanto a tecla está apertada), Alternar (1º aperto encosta, 2º solta) ou
  Toque rápido. Até **20 botões** por layout (veja "20 botões e 7 toques ao mesmo tempo" abaixo).
- **Joystick**: 4 teclas, raio do arrasto e tamanho do círculo. **Câmera**: sensibilidade X/Y, inverter Y e âncora.
- **Mostrar controles** (barra) e **Opacidade** (painel → Opções) deixam os controles mais discretos.

### 20 botões e 7 toques ao mesmo tempo (site 0.3.3)
- Cada layout (perfil × retrato/paisagem) aceita até **20 botões**. O painel mostra **n/20 botões**; no 20º o
  **+ Botão** fica desabilitado com a explicação (exclua um para criar outro). Botões novos se chamam "Botão N" e
  nascem no ponto clicado; se ali já há um controle, vão para a posição livre mais próxima (clicar várias vezes no
  mesmo ponto não empilha botões). A lista do painel rola sozinha e o editor do botão selecionado fica à vista.
- O Android injeta no máximo 10 dedos ao mesmo tempo: 1 do joystick, 1 da câmera, 1 do mouse livre e **7 para os
  botões**. Por isso, dos 20 botões, no máximo **7 podem estar apertados ao mesmo tempo**. Isso é limite do Android,
  não do site. O dedo de um botão não é mais fixo: é escolhido quando você aperta e devolvido quando solta.
- Apertar um 8º botão com 7 já apertados não faz nada (nenhum dedo é "roubado" de outro botão) e a barra mostra
  **"⚠ Limite de 7 toques simultâneos do Android"** (no máximo uma vez a cada 4 s). Soltar um botão não dispara
  depois o que foi ignorado: solte e aperte a tecla de novo.
- Botões **Alternar** ligados contam como apertados: 3 alternar ligados deixam 4 toques para os outros botões.
  **Toque rápido** e a roda ocupam um dedo só por ~60 ms.
- Perfis e arquivos exportados antes da 0.3.3 abrem iguais (o campo antigo `pointer` é ignorado). Importar um JSON
  com mais de 20 botões num layout importa os 20 primeiros e avisa.
- Voltar a uma versão antiga do site com um perfil de mais de 7 botões: o site antigo só lê os 7 primeiros (e grava
  assim). Exporte o perfil antes se precisar.

### Toques e cliques (app e site 0.3.1)
- **Clique curto agora é clique**: até a 0.3.0, um clique de tecla/mouse muitas vezes ficava "segurando" no jogo (o
  app removia o dedo sem mandar o "levantar" ao Android quando o soltar chegava no meio de um gesto). Corrigido no app
  0.3.1: todo toque termina com o "levantar", e dura pelo menos 50 ms (o jogo reconhece como toque).
- **Rede ruim (Wi-Fi)**: o canal de toques do WebRTC não retransmite pacotes. Com app e site 0.3.1, o site repete o
  apertar/soltar e avisa o celular a cada 100 ms dos dedos ainda segurados; se esse aviso parar por 0,5 s (soltar
  perdido, aba travada), o celular solta o dedo sozinho. Segurar uma tecla por muito tempo (andar com WASD) continua
  funcionando. Com o app 0.3.0 o site funciona como antes.
- Trocar de aba, Alt+Tab, abrir o menu do navegador, soltar o mouse fora da janela, sair do mouse travado ou trocar de
  modo soltam todos os dedos na hora.
- (0.3.1) Dedo parado gerava só ~4 gestos/s — essa economia causou os bugs "anda, para" e "esquerda + pular anda
  para a direita"; o app 0.3.2 voltou ao fluxo contínuo (ver abaixo).

### Toques no app 0.3.2 (correção de "anda, para" e de "A + Espaço anda para a direita")
- **Causa** (lida no código do Android 14/15, `MotionEventInjector`): para manter um dedo "segurado", o app manda ao
  Android um gesto de continuação de tempos em tempos. Com o dedo PARADO esse gesto não gera nenhum evento de toque e o
  Android o **recusa**; o app 0.3.1 tratava a recusa como cancelamento e re-encostava os dedos — e o Android então
  mandava ao jogo um **CANCEL** (soltar tudo) e um toque novo, a cada ~0,27 s (o personagem parava). No re-encostar os
  dedos ganhavam ids novos (o dedo do joystick podia ficar com o id que antes era do pulo/câmera: alguns jogos passam a
  ler o joystick na posição do botão de pular, à direita). Além disso, o Android só libera os ids quando TODOS os dedos
  levantam e, gastos os ids 0..9, dá o id 10 a todo dedo novo: com WASD segurado e muitos toques (câmera/pulo), dois
  dedos ficavam com o mesmo id.
- **Correção**: todo gesto agora gera pelo menos um evento (dedo parado faz um micro-movimento de 1 pixel, vai e volta),
  então o Android nunca recusa nem cancela; dedos segurados recebem um gesto a cada ~16 ms (fluxo contínuo, como um dedo
  real; gasta mais CPU que a 0.3.1 — ~60 gestos/s enquanto houver tecla segurada — em troca de suavidade). Um toque novo
  sempre encosta no ponto do DOWN (o centro do joystick) e arrasta. Antes que dois dedos fiquem com o mesmo id, o app
  levanta e re-encosta todos de uma vez (um "piscar" de ~10 ms, raro: só com o joystick segurado por muito tempo e
  muitos toques novos ao mesmo tempo).
- Tudo isso foi verificado num **modelo** do Android (código do AOSP transcrito nos testes), não no aparelho: confira
  com o diagnóstico abaixo.

### Diagnóstico de toque (app 0.3.2; latências e perfil no 0.3.3)
No app, marque **Diagnóstico de toque** (embaixo de **Parar**). Marcar zera os contadores; jogue um pouco, volte ao app
e anote a linha (dá para selecionar e copiar):
- **perfil** (0.3.3): perfil de fluidez ativo (o escolhido na barra do site) e o quadro do display usado (8 ms = 120 Hz).
  Trocar o perfil pelo site zera as latências (elas valem só para o perfil mostrado).
- **gestures**: total, média/s, pico/s e último segundo. Com uma tecla segurada: ~60–75/s no Equilibrado, ~120/s na
  Máxima fluidez a 120 Hz, ~20–50/s na Economia.
- **cancelados (recusados)**: gestos cancelados pelo Android (recusados = cancelados em menos de 5 ms). Esperado: 0,
  ou só quando você encosta o dedo de verdade na tela. Números altos = mande para o desenvolvedor.
- **maior lacuna com dedo segurado**: maior intervalo entre dois gestos enquanto havia dedo pressionado (esperado:
  < 25 ms no Equilibrado/Máxima fluidez, < 60 ms na Economia; centenas de ms = o jogo ficou sem eventos).
- **dedos**: ativos agora e pico. **reciclagens de ids**: quantas vezes todos os dedos foram re-encostados para não
  repetir ids.
- **latência p50/p95/máx** (0.3.3, medida NO CELULAR, das últimas 512 amostras):
  - **DOWN→dispatch**: de o pacote de uma tecla apertada chegar ao app até o `dispatchGesture` que encosta o dedo — a
    espera do planejador (gesture anterior em voo). Esperado no Equilibrado: p50 ≲ 3 ms, p95 ≲ 10 ms.
  - **pacote→dispatch**: o mesmo para qualquer pacote que muda algo (DOWN, MOVE, UP, câmera). Um UP que chega antes do
    toque mínimo (clique muito curto) espera o mínimo de propósito e aparece aqui.
  - **pacote→fim do gesture**: até o Android avisar que o gesture terminou (`onCompleted`): limite superior da entrega ao
    jogo (o DOWN/MOVE é entregue antes).

### Fluidez e latência (0.3.3): perfis e como comparar no aparelho
Na barra do site (grupo **Fluidez**) escolha **Equilibrado** (padrão), **Máxima fluidez** ou **Economia**. A escolha
fica salva no navegador, vai ao celular a cada conexão e pode ser trocada no meio do jogo (não solta dedos). Ao lado
aparece "✔ no celular · quadro N ms" quando o app 0.3.3 confirma; "app sem perfis" = app antigo (o seletor não tem
efeito). Na linha de baixo, **Enlace**: RTT do ping (mediana/p95/máx dos últimos 20, 1 por segundo), "tecla→celular ≈"
(RTT/2 + tempo do app) e "celular→toque" (a espera no celular até o `dispatchGesture`, mediana). "—" = app antigo.
- **Equilibrado**: dedo parado renovado a cada ~16 ms (como a 0.3.2), mas com segmentos curtos — a próxima tecla quase
  nunca espera. Melhor custo/benefício.
- **Máxima fluidez**: renova a cada quadro do display (8 ms a 120 Hz) e usa os menores segmentos; ~2× gestos/s do
  Equilibrado a 120 Hz (mais CPU/bateria). Toque mínimo de 40 ms (ainda > 1 quadro de um jogo a 30 fps).
- **Economia**: dedo parado renovado a cada 50 ms (o jogo pode ficar até ~50 ms sem MOVE de um dedo PARADO); toques e
  movimentos continuam imediatos. Menos gestos/s que a 0.3.2.

**Como comparar no Poco** (mesmo jogo, mesma situação, ~2 min cada): 1) escolha o perfil no site; 2) no app desmarque
e marque **Diagnóstico de toque** (zera); 3) jogue andando + pulando + atirando + mirando; 4) volte ao app e copie a
linha; 5) repita nos outros perfis. Compare DOWN→dispatch (p50/p95), maior lacuna, gestures/s e a bateria/temperatura
(Configurações → Bateria) se jogar por mais tempo. Mande também a linha **Enlace** do site (RTT/tecla→celular).

**Medições no modelo do Android** (AOSP 14/15 transcrito nos testes JVM; carga de 20 s: WASD mudando de direção a cada
100–300 ms, rajadas de 2–6 botões, câmera a 60 Hz; tempos do pacote chegar ao app até o MotionEvent entregue ao jogo,
p50/p95/máx em ms; ipc = 1 ms por chamada ao sistema; é MODELO, não o aparelho):

| 120 Hz | DOWN (tecla nova) | 2ª tecla "junta" | UP (além do mínimo) | MOVE joystick | câmera | maior lacuna | joystick fora | gestures/s |
|---|---|---|---|---|---|---|---|---|
| 0.3.2 | 10/24/28 | 15/25/26 | 14/25/39 | 22/33/34 | 5/10/19 | 31 | 2,7% | 54 |
| Equilibrado | 2/7/14 | 6/7/11 | 3/7/8 | 5/10/15 | 3/6/22 | 18 | 1,6% | 75 |
| Máxima fluidez | 2/6/12 | 4/6/11 | 2/4/5 | 3/10/13 | 2/4/20 | 9 | 1,4% | 127 |
| Economia | 3/12/18 | 8/13/13 | 5/13/14 | 9/16/19 | 5/9/26 | 54 | 1,5% | 49 |

**Medições no navegador** (Chromium, carga de multiação de 6 s: WASD, rajadas de teclas/botões do mouse, mouse a
250 Hz; do evento de teclado/mouse até o pacote chegar ao "celular" falso; "ADB" = biblioteca Tango de verdade sobre
um USB simulado SEM "delayed ack" e 1 ms por transferência — pessimista; o aparelho real pode ser mais rápido):

| transporte, app | evento→celular p50/p95/máx (ms) ANTES → DEPOIS | pacotes/s ANTES → DEPOIS | writes/s ANTES → DEPOIS |
|---|---|---|---|
| USB falso, app 0.3.1+ (caps) | 0,1/0,2/1,0 → 0,1/0,2/0,9 | 120 → 72 | 120 → 68 |
| ADB, app 0.3.1+ (caps) | 80/187/251 → 8,5/17/21 | 92 → 75 | 92 → 68 |
| ADB, app 0.3.0 (sem caps) | 12,6/46/68 → 8,5/17/21 | 78 → 79 | 78 → 71 |

Tabelas completas (60/90/120 Hz, ipc 1 e 3 ms, contribuição de cada mudança): `gradle testDebugUnitTest` grava
`android/app/build/multiaction-before-after.txt` e `multiaction-ablation.txt`.

### Ver os toques ao vivo ("Local do ponteiro")
*Opções do desenvolvedor* (Xiaomi/HyperOS: *Configurações adicionais → Opções do desenvolvedor*) → seção **Entrada** →
ligue **Local do ponteiro** (em inglês "Pointer location"; **Mostrar toques** é uma versão mais simples). Uma barra no
topo mostra quantos dedos estão no chão (`P: 2/2`), a posição e a velocidade, e cada dedo desenha uma trilha com a
cor/número do seu id. Com o jogo aberto, segure A e aperte Espaço várias vezes:
- **Esperado (0.3.2)**: a trilha do joystick começa no centro, vai para a esquerda e fica lá (tremendo 1 px) sem se
  interromper; o pulo aparece como um 2º dedo que entra e sai; o contador de dedos nunca cai a 0 enquanto A está
  segurado.
- **Bug (0.3.1)**: a trilha do joystick some e reaparece a cada ~0,3 s (CANCEL + toque novo), ou o número/cor do dedo
  do joystick muda quando o pulo entra.
Desligue a opção depois (ela também aparece no vídeo espelhado).

## Problemas comuns
- **Acessibilidade bloqueada ("configurações restritas", Xiaomi/Android 13+):** toque no item bloqueado e confirme o aviso;
  depois *Configurações → Apps → Gerenciar apps → Mirror Control → ⋮ → Permitir configurações restritas*.
- **"Conteúdo oculto por compartilhamento de tela por segurança":** aviso do próprio Android (notificações e senhas
  ficam ocultas enquanto a tela é compartilhada). Não é erro do app.
- **Site sem vídeo:** o app mostra na tela principal em que etapa parou ("Sinalização conectada", "Oferta enviada",
  "Resposta recebida", "ICE: connected/failed…") e o site tem o painel **Diagnóstico da conexão**. Celular e notebook
  devem estar na **mesma rede Wi-Fi** (sem "isolamento de clientes"/rede de convidados); em redes diferentes é preciso um
  servidor TURN. Use o ID mostrado no site (um ID antigo não conecta).
- **Mapear teclas sem o celular:** botão **Mapear teclas e mouse** na tela inicial do site (Retrato/Paisagem na barra
  trocam o layout que está sendo editado).
- **"Para girar pelo site: ative…"** na barra: ligue o serviço de acessibilidade do app ou toque em **Permitir girar a
  tela pelo site** e ative "Modificar configurações do sistema" para o Mirror Control.

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
6. O vídeo aparece com o mouse **livre** (clique = toque). Para jogar, **F8** trava o mouse (Esc solta). Teclas, mouse,
   rotação e mapeamento funcionam igual ao modo Wi-Fi (veja "Usando o site" abaixo).
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
  No modo Wi-Fi (WebRTC/VP8), aparelhos sem VP8 por hardware ficam limitados a 1080p 30 fps (o app avisa); para 60 fps
  use 720p.

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
