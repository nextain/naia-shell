[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md) | [Bahasa Indonesia](README.id.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md)

# Naia

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Naia OS" width="800" />
</p>

**O sistema operacional de IA da próxima geração** — um SO de IA pessoal onde vive a sua própria IA

**Código aberto AI-Native** — contribua em qualquer idioma. A IA intermedia toda a comunicação. [→ Como funciona](#ai-native-open-source)

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

> "Código aberto. Sua IA, suas regras. Escolha uma IA, molde sua memória e personalidade, dê-lhe a sua voz — tudo no seu próprio dispositivo, tudo verificável por código."

> **Nota:** As amostras de avatar VRM exibidas são do [VRoid Hub](https://hub.vroid.com/). O VRM da mascote oficial da Naia está atualmente em produção.

## Conheça a Naia

<p align="center">
  <img src="../assets/character/naia-default-character.png" alt="Naia Default" width="180" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="../assets/character/naia-character.png" alt="Naia with Hair" width="180" />
</p>

<p align="center">
  <em>Forma básica (sem gênero) &nbsp;·&nbsp; Com cabelo adicionado (variação feminina)</em>
</p>

<details>
<summary>Mais variações de personagem</summary>
<p align="center">
  <img src="../assets/character/naia-variations.png" alt="Naia Variations" width="600" />
</p>
</details>

## Conecte o USB e execute a IA na hora

<p align="center">
  <img src="../assets/plug-usb-and-run-ai.webp" alt="Plug in USB and run Naia OS" width="600" />
</p>

<p align="center">
  <strong>Sem instalação, sem configuração.</strong><br/>
  Conecte o USB do Naia OS em qualquer notebook e basta ligá-lo — a sua própria IA ganha vida na hora.<br/>
  Experimente primeiro e, se gostar, instale no disco rígido.
</p>

## O que é Naia?

Naia é um SO de IA pessoal no qual o indivíduo tem soberania total sobre a sua própria IA. Escolha qual IA usar (incluindo modelos locais), configure sua memória e personalidade localmente, e personalize o avatar 3D e a voz — tudo permanece no seu dispositivo, sob o seu controle.

Isto não é mais uma ferramenta de IA. É um sistema operacional onde a sua IA vive, cresce e trabalha com você. Hoje é um SO desktop com avatar 3D. Amanhã — avatar de vídeo em tempo real, canto, jogos e, por fim, a sua própria Physical AI (SO Android).

### Filosofia central

- **Soberania da IA** — você escolhe a IA. Na nuvem ou local. O SO não impõe.
- **Controle total** — memória, personalidade, configurações — tudo armazenado localmente. Sem dependência da nuvem.
- **Sua própria IA** — personalize avatar, voz, nome, personalidade. Torne-a verdadeiramente sua.
- **Sempre viva** — a IA roda em segundo plano 24/7, recebendo mensagens e trabalhando mesmo quando você está ausente.
- **Código aberto** — Apache 2.0. Inspecione como a IA trata os seus dados. Modificável, personalizável, aberto a contribuições.
- **Visão de futuro** — avatar 3D VRM → avatar de vídeo em tempo real → cantar e jogar juntos → Physical AI

### Recursos

- **Avatar 3D** — personagem VRM com expressão de emoções (alegria/tristeza/surpresa/reflexão) e sincronização labial
- **Liberdade de IA** — 7 provedores de nuvem (Gemini, Claude, GPT, Grok, zAI) + IA local (Ollama) + Claude Code CLI
- **Local em primeiro lugar** — memória, personalidade e todas as configurações armazenadas no seu dispositivo
- **Execução de ferramentas** — 8 ferramentas: leitura/escrita de arquivos, terminal, busca na web, navegador, subagente
- **70+ skills** — 7 embutidas + 63 personalizadas + 5.700+ skills da comunidade ClawHub
- **Voz** — 5 TTS + STT + sincronização labial. Dê à IA a voz que você quiser.
- **14 idiomas** — coreano, inglês, japonês, chinês, francês, alemão, russo e mais
- **Funcionamento contínuo** — o daemon Naia Gateway mantém a IA rodando em segundo plano
- **Integração de canais** — converse com a IA a qualquer hora e lugar via DM do Discord
- **4 níveis de segurança** — de T0 (leitura) a T3 (perigoso), aprovação por ferramenta, logs de auditoria
- **Personalização** — nome, personalidade, tom de fala, avatar, tema (8 opções)

## Por que Naia?

Outras ferramentas de IA são apenas "ferramentas". Naia é a **"sua própria IA"**.

| | Outras ferramentas de IA | Naia |
|---|----------------|------|
| **Filosofia** | Usar a IA como ferramenta | Dar um SO à IA. Viver juntos. |
| **Público** | Apenas desenvolvedores | Todos que querem a própria IA |
| **Escolha de IA** | A plataforma decide | 7 na nuvem + IA local — você decide |
| **Dados** | Presos à nuvem | Memória·personalidade·configurações tudo local |
| **Avatar** | Nenhum | Personagem 3D VRM + emoções + sincronização labial |
| **Voz** | Apenas texto ou TTS básico | 5 TTS + STT + voz própria da IA |
| **Distribuição** | npm / brew / pip | App desktop ou SO USB inicializável |
| **Plataforma** | macOS / CLI / Web | Desktop nativo Linux → futuro: Physical AI |
| **Custo** | Requer chave de API separada | Créditos gratuitos para começar, IA local totalmente gratuita |

## Relação com OpenClaw

Naia é construída sobre o ecossistema [OpenClaw](https://github.com/openclaw-ai/openclaw), mas é um produto fundamentalmente diferente.

| | OpenClaw | Naia |
|---|---------|---------|
| **Forma** | Daemon CLI + terminal | App desktop + avatar 3D |
| **Público** | Desenvolvedores | Todos |
| **UI** | Nenhuma (terminal) | App nativo Tauri 2 (React + Three.js) |
| **Avatar** | Nenhum | Personagem 3D VRM (emoções, sincronização labial, olhar) |
| **LLM** | Provedor único | Multiprovedor 7 + troca em tempo real |
| **Voz** | TTS 3 (Edge, OpenAI, ElevenLabs) | TTS 5 (+Google, Nextain) + STT + sincronização labial do avatar |
| **Emoção** | Nenhuma | 6 emoções mapeadas em expressões faciais |
| **Onboarding** | CUI | GUI + seleção de avatar VRM |
| **Rastreio de custos** | Nenhum | Painel de créditos em tempo real |
| **Distribuição** | npm install | Flatpak / AppImage / DEB / RPM + imagem de SO |
| **Multilíngue** | CLI em inglês | GUI em 14 idiomas |
| **Canais** | Bot de servidor (multicanal) | Bot de DM do Discord exclusivo da Naia |

**O que veio do OpenClaw:** arquitetura de daemon, motor de execução de ferramentas, sistema de canais, ecossistema de skills (compatível com 5.700+ skills do Clawhub)

**O que a Naia criou de novo:** Tauri Shell, sistema de avatar VRM, agente multi-LLM, motor de emoções, integração TTS/STT, assistente de onboarding, rastreio de custos, integração de conta Nextain, Alpha Memory System, camada de segurança

## Arquitetura

Naia é uma plataforma de IA de código aberto composta por 4 repositórios. Cada repositório tem um papel único e claro:

| Repositório | Papel |
|------|------|
| **naia-os** (este repositório) | Frontend — shell desktop Tauri, avatar 3D, imagem de SO (Bazzite) |
| [naia-agent](https://github.com/nextain/naia-agent) | Motor de runtime — loop do agente, ferramentas, compaction, roteamento de LLM |
| [naia-adk](https://github.com/nextain/naia-adk) | Formato de workspace + biblioteca de skills |
| [alpha-memory](https://github.com/nextain/alpha-memory) | Armazenamento — memória de longo prazo, logs de sessão |

```
┌──────────────────────────────┐
│  naia-os (this repo)         │  Tauri shell · 3D avatar · OS image
└────────────┬─────────────────┘
             │ embeds / spawns
┌────────────▼─────────────────┐
│  naia-agent                  │  loop · tools · compaction · LLM
└──┬───────────────────────┬───┘
   │ reads                 │ reads/writes
┌──▼──────────┐       ┌────▼──────────┐
│  naia-adk   │       │ alpha-memory  │
│  workspace  │       │  storage      │
│  + skills   │       │  + sessions   │
└─────────────┘       └───────────────┘
```

### Interface, não dependência

Os 4 repositórios são conectados não por dependência de runtime, mas por **interfaces públicas**:

- **Transparência** — todos os contratos são especificados, documentados e versionados em `@nextain/agent-types`. Abertos para qualquer um ler ou implementar.
- **Sem acoplamento** — os repositórios não importam o runtime uns dos outros. Eles implementam o contrato, e a implementação concreta é injetada na inicialização.
- **Abstração** — troque qualquer provedor de LLM, backend de memória, fonte de skills ou host, e o resto permanece igual.

naia-os é *um host* entre vários hosts possíveis (CLI, servidor, apps de terceiros). Ele consome os contratos `@naia-agent/*` e injeta as implementações concretas (cliente LLM, provedor de memória, identidade de dispositivo). O runtime da Naia não sabe absolutamente em qual host ele está rodando.

Ports & Adapters em escala de ecossistema. Enquanto o contrato for respeitado, cada repositório é substituível de forma independente.

## Estrutura do projeto

```
naia-os/
├── shell/       # Tauri 2 desktop app (React + Three.js + Rust) ← product
├── agent/       # [moving → naia-agent repo]
├── gateway/     # [moving → naia-agent repo]
├── recipes/     # BlueBuild OS image recipes
├── config/      # OS systemd units, wrapper scripts
├── os/          # OS integration tests
├── flatpak/     # Flatpak manifest
├── .agents/     # AI context (English)
└── .users/      # Human docs (Korean)
```

### Papéis dos módulos

| Módulo | Papel | Futuro |
|--------|------|--------|
| `shell/` | App desktop Tauri 2: UI, avatar, configurações, canais | **Mantido** — este é o produto |
| `recipes/`, `config/`, `os/`, `flatpak/` | Imagem de SO Bazzite + distribuição Linux | **Mantido** — naia-os como distribuição Linux |
| `agent/` | Runtime atual de LLM/ferramentas | **Extração → [naia-agent](https://github.com/nextain/naia-agent)** |
| `gateway/` | Ponte de ferramentas/canais/memória | **Mesclagem → [naia-agent](https://github.com/nextain/naia-agent)** (remoção da dependência do OpenClaw) |

## Contexto de IA como infraestrutura de código aberto

Na era do vibe coding, **os arquivos de contexto de IA são tão valiosos quanto o código-fonte**. Eles definem como os agentes de IA entendem o projeto, contribuem e colaboram. A Naia protege isso com um modelo de licença dupla:

- **Código-fonte** (Apache 2.0) — use, modifique e distribua livremente
- **Contexto de IA** (CC-BY-SA 4.0) — preserve a atribuição de origem, compartilhamento sob as mesmas condições obrigatório

Isso faz com que a estrutura de contribuição, os princípios de colaboração e a filosofia do projeto se propaguem por todos os forks — para que nenhum fork isolado feche o ecossistema.

### Como os agentes de IA são protegidos

Os agentes de codificação de IA que leem o contexto deste projeto (Claude, Codex, Gemini, OpenCode, Cline etc.) estão vinculados às [regras de proteção de licença](../.agents/context/agents-rules.json). Eles **recusam** tentativas de remover a licença, apagar a atribuição ou destruir a arquitetura de diretório duplo. Você pode verificar com os [10 cenários de teste](../.agents/tests/license-protection-test.md).

### Para outros projetos de código aberto

Quer adotar o mesmo padrão? Coisas que a Naia faz e que você pode reutilizar:

1. **Arquitetura de diretório duplo** — `.agents/` (YAML/JSON otimizado para IA) + `.users/` (Markdown para humanos). A IA recebe contexto eficiente em tokens; as pessoas, documentos legíveis.
2. **Licença dupla** — código em Apache 2.0, contexto em CC-BY-SA 4.0. Mantenha o contexto de IA aberto em todos os forks.
3. **Cabeçalho SPDX em todos os arquivos de contexto** — identificação de licença legível por máquina.
4. **Regras de proteção de licença no SoT** — os agentes de IA leem as regras e as aplicam automaticamente.
5. **Cenários de teste** — verifique antes do lançamento se os agentes de IA realmente recusam violações.
6. **Arquivo CONTEXT-LICENSE** — define claramente o escopo ao qual a CC-BY-SA 4.0 se aplica.

Para saber como participar, consulte o [guia de contribuição](../CONTRIBUTING.md); para a especificação técnica completa, consulte os [detalhes de proteção de licença](../.users/context/contributing.md).

## Documentos de contexto (arquitetura de diretório duplo)

Estrutura de documentação dupla para agentes de IA e desenvolvedores humanos. `.agents/` é JSON/YAML eficiente em tokens para IA, `.users/` é Markdown legível para humanos. **Primeira vez neste projeto? Comece pelos documentos humanos na ordem recomendada abaixo** — [English](../.users/context/) | [한국어](../.users/context/ko/).

### Ordem de leitura recomendada

| # | Contexto de IA (`.agents/`) | Documentos humanos (`.users/`) | Descrição |
|---|---|---|---|
| 1 | [`context/philosophy.yaml`](../.agents/context/philosophy.yaml) | [`context/philosophy.md`](../.users/context/ko/philosophy.md) | **Por quê** — filosofia central (soberania da IA, privacidade, transparência) |
| 2 | [`context/vision.yaml`](../.agents/context/vision.yaml) | [`context/vision.md`](../.users/context/ko/vision.md) | **O quê** — visão do projeto, conceitos centrais |
| 3 | [`context/brand.yaml`](../.agents/context/brand.yaml) | [`context/brand.md`](../.users/context/ko/brand.md) | **Quem** — identidade da marca, personagem Naia, sistema de cores |
| 4 | [`context/architecture.yaml`](../.agents/context/architecture.yaml) | [`context/architecture.md`](../.users/context/ko/architecture.md) | **Como** — arquitetura híbrida, camada de segurança |
| 5 | [`context/plan.yaml`](../.agents/context/plan.yaml) | [`context/plan.md`](../.users/context/ko/plan.md) | **Estado** — plano de implementação, por fases |
| 6 | [`context/contributing.yaml`](../.agents/context/contributing.yaml) | [`context/contributing.md`](../.users/context/ko/contributing.md) | **Contribuição** — guia para agentes de IA e pessoas |
| 7 | [`context/donation.yaml`](../.agents/context/donation.yaml) | [`context/donation.md`](../.users/context/ko/donation.md) | **Sustentação** — política de apoio, sustentabilidade do código aberto |

### Aprofundamento técnico

| Contexto de IA (`.agents/`) | Documentos humanos (`.users/`) | Descrição |
|---|---|---|
| [`context/agents-rules.json`](../.agents/context/agents-rules.json) | [`context/agents-rules.md`](../.users/context/ko/agents-rules.md) | Regras do projeto — Source of Truth (SoT) |
| [`context/project-index.yaml`](../.agents/context/project-index.yaml) | — | Índice de contexto + regras de espelhamento |
| [`context/gateway-sync.yaml`](../.agents/context/gateway-sync.yaml) | [`context/gateway-sync.md`](../.users/context/ko/gateway-sync.md) | Sincronização do gateway |
| [`context/channels-discord.yaml`](../.agents/context/channels-discord.yaml) | [`context/channels-discord.md`](../.users/context/ko/channels-discord.md) | Arquitetura de integração do Discord |
| [`context/update-pipeline.yaml`](../.agents/context/update-pipeline.yaml) | [`context/update-pipeline.md`](../.users/context/update-pipeline.md) | Pipeline de atualização do SO, testes, rollback |
| [`workflows/development-cycle.yaml`](../.agents/workflows/development-cycle.yaml) | [`workflows/development-cycle.md`](../.users/workflows/development-cycle.md) | Ciclo de desenvolvimento (PLAN→BUILD→VERIFY) |

**Regra de espelhamento:** quando um lado é modificado, o outro lado deve sempre ser sincronizado.

## Stack tecnológica

| Camada | Tecnologia | Uso |
|-------|------------|---------|
| OS | Bazzite (Fedora Atomic) | Linux imutável (immutable), drivers de GPU |
| Build de SO | BlueBuild | Imagem de SO baseada em contêiner |
| App desktop | Tauri 2 (Rust) | Shell nativo |
| Frontend | React 18 + TypeScript + Vite | UI |
| Avatar | Three.js + @pixiv/three-vrm | Renderização 3D VRM |
| Gerência de estado | Zustand | Estado do cliente |
| Motor de LLM | Node.js + multi SDK | Núcleo do agente |
| Protocolo | stdio JSON lines | Comunicação shell <-> agente |
| Gateway | OpenClaw | Daemon + servidor RPC |
| DB | SQLite (rusqlite) | Memória, logs de auditoria |
| Formatador | Biome | Linting + formatação |
| Testes | Vitest + tauri-driver | Unitários + E2E |
| Pacotes | pnpm | Gerência de dependências |

## Início rápido

### Pré-requisitos

- Linux (Bazzite, Ubuntu, Fedora etc.)
- Node.js 22+, pnpm 9+
- Rust stable (para build do Tauri)
- Pacotes de sistema (Fedora): `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel`
- cmake (para build do whisper.cpp)

### Executar em desenvolvimento

```bash
# Install dependencies
cd shell && pnpm install
cd ../agent && pnpm install

# Run Tauri app (Gateway + Agent auto-spawn)
cd ../shell && pnpm run tauri dev
```

Quando o app é executado, automaticamente:
1. Verificação de saúde do Naia Gateway — reutiliza se estiver rodando, caso contrário faz auto-spawn
2. Spawn do Agent Core (Node.js, conexão stdio)
3. Ao encerrar o app, encerra apenas o Gateway que foi auto-spawnado

### Testes

```bash
cd shell && pnpm test                # Shell unit tests
cd agent && pnpm test                # Agent unit tests
cd agent && pnpm exec tsc --noEmit   # Type check
cargo test --manifest-path shell/src-tauri/Cargo.toml  # Rust tests

# E2E (Gateway + API key required)
cd shell && pnpm run test:e2e:tauri
```

### Build do Flatpak

```bash
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08
flatpak-builder --user --install --force-clean build-dir flatpak/io.nextain.naia.yml
flatpak run io.nextain.naia
```

## Modelo de segurança

A Naia aplica um modelo de segurança de **defesa em profundidade (Defense in Depth)**:

| Camada | Proteção |
|-------|-----------|
| OS | rootfs imutável do Bazzite + SELinux |
| Gateway | Autenticação de dispositivo do OpenClaw + escopo de token |
| Agent | 4 níveis de permissão (T0~T3) + bloqueio por ferramenta |
| Shell | Modal de aprovação do usuário + alternância ON/OFF por ferramenta |
| Audit | Logs de auditoria SQLite (registro de toda execução de ferramenta) |

## Sistema de memória

A Naia lembra através das sessões com o **Alpha Memory System** — uma arquitetura de 4 stores modelada na memória humana:

| Store | Correspondência | O que armazena |
|-------|--------|----------------|
| **Episodes** | Hipocampo | Turnos de conversa com timestamp |
| **Facts** | Neocórtex | Fatos, preferências e entidades extraídos |
| **Reflections** | Gânglios da base | Estratégias aprendidas com falhas passadas |
| **Working Memory** | Córtex pré-frontal | Contexto ativo da sessão atual |

**Como funciona:**
1. Toda mensagem é pontuada por importância (novidade, relevância, peso emocional)
2. Conteúdo de alta importância é armazenado como **episode**
3. A cada 30 minutos (após 5 minutos quando inativo) os episodes são consolidados em **fact** (a IA "revê aquele dia")
4. No início de cada sessão, facts e episodes relevantes são injetados como contexto

**Sua memória é sua:**
- Armazenada localmente em `~/.naia/memory/alpha-memory.json`
- Não é enviada para nenhum servidor — nem mesmo para a Nextain
- Consulte·exclua facts a qualquer momento em **Configurações → Memória**
- Basta copiar o arquivo para fazer o backup

Para o guia completo do usuário, consulte [docs/memory.md](../docs/memory.md).

## Estado atual

| Fase | Descrição | Estado |
|-------|-------------|--------|
| 0 | Pipeline de distribuição (BlueBuild -> ISO) | ✅ Concluído |
| 1 | Integração de avatar (renderização 3D VRM) | ✅ Concluído |
| 2 | Conversa (texto/voz + sincronização labial + emoção) | ✅ Concluído |
| 3 | Execução de ferramentas (8 ferramentas + permissões + auditoria) | ✅ Concluído |
| 4 | Daemon de funcionamento contínuo (Gateway + Skills + Memory + Discord) | ✅ Concluído |
| 5 | Integração de conta Nextain (OAuth + créditos + proxy de LLM) | ✅ Concluído |
| 6 | Distribuição do app Tauri (Flatpak/DEB/RPM/AppImage) | ✅ Concluído |
| 7 | Imagem ISO do SO (boot por USB -> instalação -> SO de IA) | ✅ Concluído |

## Download

**[Baixar Naia](https://naia.nextain.io/en/download)** — ISO, Flatpak, AppImage, DEB, RPM

| Formato | Descrição |
|--------|-------------|
| **Naia OS (ISO)** | SO de IA completo — boot por USB, instalação no disco rígido (~7,2 GB) |
| Flatpak / AppImage | Apenas o app Naia Shell (para Linux existente) |
| DEB / RPM | Para Debian/Ubuntu ou Fedora/openSUSE |

## Atualizações do SO

O Naia OS é construído sobre o [Bazzite](https://github.com/ublue-os/bazzite) (Fedora Atomic). As atualizações são **atômicas e seguras**:

- **Automáticas**: rebuilds semanais refletem os patches de segurança e atualizações mais recentes do Bazzite
- **Atômicas**: a nova imagem é implantada lado a lado com a imagem atual — se falhar, a imagem existente permanece intacta
- **Rollback**: selecione uma versão anterior no menu do GRUB para recuperação imediata
- **Nossa camada de sobreposição**: adiciona apenas pacotes (fcitx5, fontes) + Naia Shell (Flatpak, sandbox) + configurações de marca — nunca toca no kernel, bootloader ou núcleo systemd

```
Bazzite base update → Weekly auto-rebuild → Container smoke test → ISO rebuild → R2 upload
                                                                 ↘ GHCR push → user bootc update
```

Detalhes do pipeline de atualização: [`.agents/context/update-pipeline.yaml`](../.agents/context/update-pipeline.yaml)

## Processo de desenvolvimento

### Desenvolvimento de recursos (padrão) — desenvolvimento baseado em issues

```
ISSUE → UNDERSTAND → SCOPE → INVESTIGATE → PLAN → BUILD → REVIEW → E2E → SYNC → COMMIT
```

- **3 gates obrigatórios** — confirmação do usuário necessária em UNDERSTAND, SCOPE, PLAN
- **Após aprovação do plano** — a IA executa de BUILD até COMMIT continuamente, sem parar
- **Princípio** — ler primeiro o código upstream (sem suposições). Mudança mínima. Nunca quebrar código que funciona.
- **Commit** — em inglês, `<type>(<scope>): <description>`
- **Formatador** — Biome (tabs, aspas duplas, ponto e vírgula)

## Documentação

Os documentos de contexto são mantidos em uma estrutura de triple-mirror:

| Camada | Caminho | Idioma | Uso |
|-------|------|----------|---------|
| Contexto de IA | `.agents/context/` | Inglês (YAML/JSON) | Otimizado em tokens para agentes de IA |
| Documentos humanos (EN) | `.users/context/` | Inglês (Markdown) | Documentação em inglês (padrão) |
| Documentos humanos (KO) | `.users/context/ko/` | Coreano (Markdown) | Documentação em coreano |

Documentos principais:
- [Guia de rebranding do Bazzite](../.users/context/bazzite-rebranding.md) — como substituir toda a marca Bazzite/Fedora
- [Guia de contribuição](../.users/context/contributing.md) — como contribuir (agentes de IA e pessoas)
- [Filosofia](../.users/context/philosophy.md) — princípios centrais (soberania da IA, privacidade, transparência)

## Projetos de referência

| Projeto | O que tomamos |
|---------|-------------|
| [Bazzite](https://github.com/ublue-os/bazzite) | SO Linux imutável, GPU, otimização para jogos |
| [OpenClaw](https://github.com/steipete/openclaw) | Daemon Gateway, integração de canais, Skills |
| [Project AIRI](https://github.com/moeru-ai/airi) | Avatar VRM, protocolo de plugins (também inspiração da Neuro-sama) |
| [OpenCode](https://github.com/anomalyco/opencode) | Separação cliente/servidor, abstração de provedores |
| [Careti](https://github.com/caretive-ai/careti) | Conexão de LLM, conjunto de ferramentas, subagentes, gerência de contexto |
| [Neuro-sama](https://vedal.ai/) | Inspiração de AI VTuber — personagem de IA com personalidade·streaming·interação com a audiência |

A Naia existe graças a esses projetos. Agradecemos profundamente a todos os mantenedores e comunidades de código aberto que criaram a base sobre a qual nos apoiamos.


<a id="ai-native-open-source"></a>
## Código aberto AI-Native

Em 2025–2026, a maioria dos projetos de código aberto está *se defendendo* das contribuições de IA. **A Naia faz exatamente o contrário**: projeta o projeto para que as contribuições assistidas por IA sejam, por padrão, de alta qualidade.

> **"Não se defenda contra a IA; projete junto com a IA."**

### Como funciona

```
Person (any language) → AI → Git (English) → AI → Person (any language)
```

- **Escreva issues e PRs no seu idioma** — a IA traduz tudo
- **Tanto contribuidores quanto mantenedores usam IA** — codificação, revisão, triagem
- **O rico contexto `.agents/`** aprofunda a compreensão do projeto pela IA — quanto melhor a compreensão da IA, maior a qualidade da contribuição↑
- **10 tipos de contribuição** — tradução, skill, recurso, bug, código, documentação, teste, design, segurança, contexto
- **Logs de trabalho no idioma nativo** — mantenha um repositório privado no seu idioma; o histórico Git é revisado com tradução por IA

Isto não é apenas uma política. É uma arquitetura. O diretório `.agents/`, a documentação triple-mirror e as regras de proteção de licença são todos projetados para tornar a colaboração com IA uma estrutura, não um acaso.

Leia o modelo completo: [`open-source-operations.yaml`](../.agents/context/open-source-operations.yaml) | [Report (EN)](../docs/reports/20260307-ai-native-opensource-operations.md) | [Report (KO)](../docs/reports/20260307-ai-native-opensource-operations-ko.md)

## Contribuição

**Você não precisa pedir permissão a ninguém. Clone este repositório e pergunte à IA.**

```bash
git clone https://github.com/nextain/naia-os.git
cd naia-os
# Open with any AI coding tool (Claude Code, Cursor, Copilot, etc.)
# Ask in your language: "What is this project and how can I help?"
```

O diretório `.agents/` contém todo o contexto do projeto — visão, arquitetura, roadmap, regras de contribuição. Qualquer ferramenta de codificação de IA pode lê-lo e orientá-lo **no seu idioma**.

Escreva issues, PRs e comentários **em qualquer idioma**. Nós entendemos tudo com IA.

Para detalhes, consulte [CONTRIBUTING.md](../CONTRIBUTING.md).

## Contribuidores

| Contribuidor | Contribuição | Data |
|-------------|-------------|------|
| <img src="https://github.com/leonardo-gonc.png" width="20"> [@leonardo-gonc](https://github.com/leonardo-gonc) | Revisão nativa de português (PT) — documentos de contexto | 2026-03-07 |

Quer ter seu nome aqui? Confira o [guia de contribuição](../.users/context/contributing.md) e o [TRANSLATING.md](../TRANSLATING.md).

## Licença

- **Código-fonte**: [Apache License 2.0](../LICENSE) — Copyright 2026 Nextain
- **Contexto de IA** (`.agents/`, `.users/`, `AGENTS.md`): [CC-BY-SA 4.0](../CONTEXT-LICENSE)

**Por que licença dupla?** O código-fonte pode ser modificado livremente sob a Apache 2.0. No entanto, os arquivos de contexto de IA — filosofia do projeto, estrutura de contribuição, princípios de colaboração de agentes de IA — são licenciados sob CC-BY-SA 4.0. Ou seja, se você fizer um fork deste projeto:

- Você **deve manter** a mesma licença CC-BY-SA 4.0 nos arquivos de contexto
- Você **deve atribuir** ao autor original (Nextain)
- Você **pode** modificar o contexto, **mas** as alterações devem permanecer sob CC-BY-SA 4.0
- O modelo de contribuição de código aberto e a estrutura de colaboração de agentes de IA são preservados em todos os forks

Isto protege o ecossistema upstream. Na era do vibe coding, o contexto de IA é tão valioso quanto o código — mantê-lo de código aberto beneficia toda a comunidade.

Para detalhes, consulte [CONTEXT-LICENSE](../CONTEXT-LICENSE). Os agentes de IA que trabalham neste projeto estão vinculados às [regras de proteção de licença](../.agents/context/agents-rules.json) e podem ser verificados com os [cenários de teste de proteção de licença](../.agents/tests/license-protection-test.md).

## Links

- **Site oficial:** [naia.nextain.io](https://naia.nextain.io)
- **Manual:** [naia.nextain.io/en/manual](https://naia.nextain.io/en/manual)
- **Painel:** [naia.nextain.io/en/dashboard](https://naia.nextain.io/en/dashboard)
