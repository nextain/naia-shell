[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [Español](README.es.md) | [Português](README.pt.md) | [Tiếng Việt](README.vi.md) | [Bahasa Indonesia](README.id.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [বাংলা](README.bn.md)

# Naia

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Naia OS" width="800" />
</p>

**El sistema operativo de IA de próxima generación** — un sistema operativo de IA personal donde vive tu propia IA

**Código abierto AI-Native** — contribuye en cualquier idioma. La IA media toda la comunicación. [→ Cómo funciona](#ai-native-open-source)

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

> "Código abierto. Tu IA, tus reglas. Elige tu IA, moldea su memoria y su personalidad, dale tu voz — todo en tu propio dispositivo, todo verificable mediante código."

> **Nota:** El avatar VRM de muestra que se muestra proviene de [VRoid Hub](https://hub.vroid.com/). El VRM oficial de la mascota de Naia está actualmente en producción.

## Conoce a Naia

<p align="center">
  <img src="../assets/character/naia-default-character.png" alt="Naia Default" width="180" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="../assets/character/naia-character.png" alt="Naia with Hair" width="180" />
</p>

<p align="center">
  <em>Forma básica (sin género) &nbsp;·&nbsp; Con cabello añadido (variante femenina)</em>
</p>

<details>
<summary>Más variaciones del personaje</summary>
<p align="center">
  <img src="../assets/character/naia-variations.png" alt="Naia Variations" width="600" />
</p>
</details>

## Conecta el USB y ejecuta la IA al instante

<p align="center">
  <img src="../assets/plug-usb-and-run-ai.webp" alt="Plug in USB and run Naia OS" width="600" />
</p>

<p align="center">
  <strong>Sin instalación, sin configuración.</strong><br/>
  Conecta el USB de Naia OS a cualquier portátil y enciéndelo — tu propia IA cobra vida al instante.<br/>
  Pruébalo primero y, si te gusta, instálalo en el disco duro.
</p>

## ¿Qué es Naia?

Naia es un sistema operativo de IA personal en el que cada persona tiene soberanía total sobre su propia IA. Elige qué IA usar (incluidos modelos locales), configura su memoria y personalidad localmente, y personaliza el avatar 3D y la voz — todo permanece en tu dispositivo, bajo tu control.

Esto no es otra herramienta de IA más. Es un sistema operativo donde tu IA vive, crece y trabaja contigo. Hoy es un sistema operativo de escritorio con un avatar 3D. Mañana — avatares de vídeo en tiempo real, canto, juegos y, finalmente, tu propia IA Física (un sistema operativo Android).

### Filosofía central

- **Soberanía de IA** — tú eliges la IA. Nube o local. El sistema operativo no te impone nada.
- **Control total** — memoria, personalidad, configuración — todo almacenado localmente. Sin dependencia de la nube.
- **Tu propia IA** — personaliza avatar, voz, nombre y personalidad. Realmente tuya.
- **Siempre viva** — la IA se ejecuta en segundo plano 24/7, recibe mensajes y trabaja incluso cuando no estás.
- **Código abierto** — Apache 2.0. Inspecciona cómo tu IA maneja tus datos. Modifícala, personalízala y contribuye.
- **Visión de futuro** — avatar 3D VRM → avatar de vídeo en tiempo real → cantar y jugar juntos → IA Física

### Funciones

- **Avatar 3D** — personaje VRM con expresiones emocionales (alegría/tristeza/sorpresa/pensamiento) y sincronización labial
- **Libertad de IA** — 7 proveedores en la nube (Gemini, Claude, GPT, Grok, zAI) + IA local (Ollama) + Claude Code CLI
- **Local primero** — memoria, personalidad y toda la configuración almacenadas en tu dispositivo
- **Ejecución de herramientas** — 8 herramientas: lectura/escritura de archivos, terminal, búsqueda web, navegador, subagentes
- **Más de 70 skills** — 7 integradas + 63 personalizadas + más de 5.700 skills comunitarias de ClawHub
- **Voz** — 5 motores TTS + STT + sincronización labial. Dale a tu IA la voz que quieras.
- **14 idiomas** — coreano, inglés, japonés, chino, francés, alemán, ruso y más
- **Funcionamiento permanente** — el demonio Naia Gateway mantiene la IA ejecutándose en segundo plano
- **Integración de canales** — habla con tu IA en cualquier momento y lugar mediante DM de Discord
- **Seguridad de 4 niveles** — desde T0 (lectura) hasta T3 (peligroso), aprobación por herramienta, registros de auditoría
- **Personalización** — nombre, personalidad, tono, avatar, temas (8 opciones)

## ¿Por qué Naia?

Otras herramientas de IA son solo "herramientas". Naia es **"tu propia IA"**.

| | Otras herramientas de IA | Naia |
|---|----------------|------|
| **Filosofía** | Usar la IA como herramienta | Darle un sistema operativo a la IA. Vivir juntos. |
| **Público** | Solo desarrolladores | Cualquiera que quiera su propia IA |
| **Elección de IA** | La plataforma decide | 7 en la nube + IA local — tú decides |
| **Datos** | Atados a la nube | Memoria, personalidad y configuración totalmente locales |
| **Avatar** | Ninguno | Personaje 3D VRM + emociones + sincronización labial |
| **Voz** | Solo texto o TTS básico | 5 TTS + STT + voz propia de la IA |
| **Distribución** | npm / brew / pip | Aplicación de escritorio o sistema operativo USB de arranque |
| **Plataforma** | macOS / CLI / Web | Escritorio nativo de Linux → futuro: IA Física |
| **Coste** | Requiere clave de API aparte | Crédito gratuito para empezar, IA local totalmente gratis |

## Relación con OpenClaw

Naia está construida sobre el ecosistema de [OpenClaw](https://github.com/openclaw-ai/openclaw), pero es un producto fundamentalmente distinto.

| | OpenClaw | Naia |
|---|---------|---------|
| **Forma** | Demonio CLI + terminal | Aplicación de escritorio + avatar 3D |
| **Público** | Desarrolladores | Todos |
| **UI** | Ninguna (terminal) | Aplicación nativa Tauri 2 (React + Three.js) |
| **Avatar** | Ninguno | Personaje 3D VRM (emociones, sincronización labial, mirada) |
| **LLM** | Proveedor único | Multiproveedor 7 + cambio en tiempo real |
| **Voz** | TTS 3 (Edge, OpenAI, ElevenLabs) | TTS 5 (+Google, Nextain) + STT + sincronización labial del avatar |
| **Emociones** | Ninguna | 6 emociones mapeadas a expresiones faciales |
| **Onboarding** | CUI | GUI + selección de avatar VRM |
| **Seguimiento de costes** | Ninguno | Panel de créditos en tiempo real |
| **Distribución** | npm install | Flatpak / AppImage / DEB / RPM + imagen de SO |
| **Multilingüe** | CLI en inglés | GUI en 14 idiomas |
| **Canales** | Bot de servidor (multicanal) | Bot de DM de Discord exclusivo de Naia |

**Lo que tomamos de OpenClaw:** arquitectura del demonio, motor de ejecución de herramientas, sistema de canales, ecosistema de skills (compatible con más de 5.700 skills de Clawhub)

**Lo que Naia creó de nuevo:** Tauri Shell, sistema de avatar VRM, agente multi-LLM, motor de emociones, integración TTS/STT, asistente de onboarding, seguimiento de costes, integración con cuentas Nextain, Alpha Memory System, capa de seguridad

## Arquitectura

Naia es una plataforma de IA de código abierto compuesta por 4 repos. Cada repo tiene un único rol claro:

| Repo | Rol |
|------|------|
| **naia-os** (este repo) | Frontend — Tauri desktop shell, avatar 3D, imagen de SO (Bazzite) |
| [naia-agent](https://github.com/nextain/naia-agent) | Motor de tiempo de ejecución — bucle de agente, herramientas, compaction, enrutamiento de LLM |
| [naia-adk](https://github.com/nextain/naia-adk) | Formato de espacio de trabajo + biblioteca de skills |
| [alpha-memory](https://github.com/nextain/alpha-memory) | Almacenamiento — memoria a largo plazo, registros de sesión |

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

### Interfaces, no dependencias

Los 4 repos no están conectados por dependencias de tiempo de ejecución, sino por **interfaces públicas**:

- **Transparencia** — todos los contratos están especificados, documentados y versionados en `@nextain/agent-types`. Abiertos para que cualquiera los lea o implemente.
- **Sin acoplamiento** — los repos no importan los tiempos de ejecución de los demás. Implementan el contrato y la implementación concreta se inyecta al iniciar.
- **Abstracción** — cambia cualquier proveedor de LLM, backend de memoria, fuente de skills o host, y el resto sigue igual.

naia-os es *un host* entre varios posibles (CLI, servidor, aplicaciones de terceros). Consume los contratos `@naia-agent/*` e inyecta implementaciones concretas (cliente de LLM, proveedor de memoria, identidad del dispositivo). El tiempo de ejecución de Naia no sabe en absoluto dentro de qué host se está ejecutando.

Ports & Adapters a escala de ecosistema. Mientras se respeten los contratos, cada repo es reemplazable de forma independiente.

## Estructura del proyecto

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

### Roles de los módulos

| Módulo | Rol | Futuro |
|--------|------|--------|
| `shell/` | Aplicación de escritorio Tauri 2: UI, avatar, configuración, canales | **Se mantiene** — esto es el producto |
| `recipes/`, `config/`, `os/`, `flatpak/` | Imagen de SO Bazzite + distribución Linux | **Se mantiene** — naia-os como distribución Linux |
| `agent/` | Tiempo de ejecución actual de LLM/herramientas | **Extracción → [naia-agent](https://github.com/nextain/naia-agent)** |
| `gateway/` | Puente de herramientas/canales/memoria | **Fusión → [naia-agent](https://github.com/nextain/naia-agent)** (eliminación de la dependencia de OpenClaw) |

## El contexto de IA como infraestructura de código abierto

En la era del vibe coding, **los archivos de contexto de IA son tan valiosos como el código fuente**. Definen cómo los agentes de IA entienden, contribuyen y colaboran en el proyecto. Naia lo protege con un modelo de licencia dual:

- **Código fuente** (Apache 2.0) — uso, modificación y distribución libres
- **Contexto de IA** (CC-BY-SA 4.0) — conservación obligatoria de la atribución, compartición obligatoria bajo las mismas condiciones

Esto hace que la estructura de contribución, los principios de colaboración y la filosofía del proyecto se propaguen a través de todos los forks — de modo que ningún fork individual pueda cerrar el ecosistema.

### Cómo se protege a los agentes de IA

Los agentes de codificación de IA que leen el contexto de este proyecto (Claude, Codex, Gemini, OpenCode, Cline, etc.) están sujetos a las [reglas de protección de licencia](../.agents/context/agents-rules.json). **Rechazan** los intentos de eliminar la licencia, borrar la atribución o destruir la arquitectura de doble directorio. Puede verificarse con [10 escenarios de prueba](../.agents/tests/license-protection-test.md).

### Para otros proyectos de código abierto

¿Quieres adoptar el mismo patrón? Lo que Naia hace y puedes reutilizar:

1. **Arquitectura de doble directorio** — `.agents/` (YAML/JSON optimizado para IA) + `.users/` (Markdown para humanos). La IA obtiene contexto eficiente en tokens, las personas obtienen documentación fácil de leer.
2. **Licencia dual** — el código es Apache 2.0, el contexto es CC-BY-SA 4.0. Mantiene el contexto de IA abierto a través de todos los forks.
3. **Cabecera SPDX en todos los archivos de contexto** — identificación de licencia legible por máquina.
4. **Reglas de protección de licencia en el SoT** — los agentes de IA leen las reglas y las aplican automáticamente.
5. **Escenarios de prueba** — verifica antes del lanzamiento que los agentes de IA realmente rechazan las infracciones.
6. **Archivo CONTEXT-LICENSE** — define claramente el alcance al que se aplica CC-BY-SA 4.0.

Para saber cómo participar, consulta la [guía de contribución](../CONTRIBUTING.md); para la especificación técnica completa, consulta [detalles de la protección de licencia](../.users/context/contributing.md).

## Documentos de contexto (arquitectura de doble directorio)

Una estructura de documentación dual para agentes de IA y desarrolladores humanos. `.agents/` es JSON/YAML eficiente en tokens para la IA, `.users/` es Markdown fácil de leer para humanos. **¿Es tu primera vez en este proyecto? Empieza por los documentos para humanos en el orden recomendado a continuación** — [English](../.users/context/) | [한국어](../.users/context/ko/).

### Orden de lectura recomendado

| # | Contexto de IA (`.agents/`) | Documentos para humanos (`.users/`) | Descripción |
|---|---|---|---|
| 1 | [`context/philosophy.yaml`](../.agents/context/philosophy.yaml) | [`context/philosophy.md`](../.users/context/ko/philosophy.md) | **Por qué** — filosofía central (soberanía de IA, privacidad, transparencia) |
| 2 | [`context/vision.yaml`](../.agents/context/vision.yaml) | [`context/vision.md`](../.users/context/ko/vision.md) | **Qué** — visión del proyecto, conceptos centrales |
| 3 | [`context/brand.yaml`](../.agents/context/brand.yaml) | [`context/brand.md`](../.users/context/ko/brand.md) | **Quién** — identidad de marca, personaje Naia, sistema de color |
| 4 | [`context/architecture.yaml`](../.agents/context/architecture.yaml) | [`context/architecture.md`](../.users/context/ko/architecture.md) | **Cómo** — arquitectura híbrida, capa de seguridad |
| 5 | [`context/plan.yaml`](../.agents/context/plan.yaml) | [`context/plan.md`](../.users/context/ko/plan.md) | **Estado** — plan de implementación, por fases |
| 6 | [`context/contributing.yaml`](../.agents/context/contributing.yaml) | [`context/contributing.md`](../.users/context/ko/contributing.md) | **Contribuir** — guía para agentes de IA y personas |
| 7 | [`context/donation.yaml`](../.agents/context/donation.yaml) | [`context/donation.md`](../.users/context/ko/donation.md) | **Sostenibilidad** — política de donaciones, sostenibilidad del código abierto |

### Profundización técnica

| Contexto de IA (`.agents/`) | Documentos para humanos (`.users/`) | Descripción |
|---|---|---|
| [`context/agents-rules.json`](../.agents/context/agents-rules.json) | [`context/agents-rules.md`](../.users/context/ko/agents-rules.md) | Reglas del proyecto — Source of Truth (SoT) |
| [`context/project-index.yaml`](../.agents/context/project-index.yaml) | — | Índice de contexto + reglas de mirroring |
| [`context/gateway-sync.yaml`](../.agents/context/gateway-sync.yaml) | [`context/gateway-sync.md`](../.users/context/ko/gateway-sync.md) | Sincronización del gateway |
| [`context/channels-discord.yaml`](../.agents/context/channels-discord.yaml) | [`context/channels-discord.md`](../.users/context/ko/channels-discord.md) | Arquitectura de integración de Discord |
| [`context/update-pipeline.yaml`](../.agents/context/update-pipeline.yaml) | [`context/update-pipeline.md`](../.users/context/update-pipeline.md) | Pipeline de actualización del SO, pruebas, rollback |
| [`workflows/development-cycle.yaml`](../.agents/workflows/development-cycle.yaml) | [`workflows/development-cycle.md`](../.users/workflows/development-cycle.md) | Ciclo de desarrollo (PLAN→BUILD→VERIFY) |

**Regla de mirroring:** cuando se modifica un lado, el otro debe sincronizarse siempre.

## Stack tecnológico

| Capa | Tecnología | Uso |
|-------|------------|---------|
| SO | Bazzite (Fedora Atomic) | Linux inmutable (immutable), controladores de GPU |
| Build de SO | BlueBuild | Imagen de SO basada en contenedores |
| Aplicación de escritorio | Tauri 2 (Rust) | Shell nativo |
| Frontend | React 18 + TypeScript + Vite | UI |
| Avatar | Three.js + @pixiv/three-vrm | Renderizado VRM 3D |
| Gestión de estado | Zustand | Estado del cliente |
| Motor LLM | Node.js + multi SDK | Núcleo del agente |
| Protocolo | stdio JSON lines | Comunicación shell <-> agente |
| Gateway | OpenClaw | Demonio + servidor RPC |
| BD | SQLite (rusqlite) | Memoria, registros de auditoría |
| Formateador | Biome | Linting + formateo |
| Pruebas | Vitest + tauri-driver | Unitarias + E2E |
| Paquetes | pnpm | Gestión de dependencias |

## Inicio rápido

### Requisitos previos

- Linux (Bazzite, Ubuntu, Fedora, etc.)
- Node.js 22+, pnpm 9+
- Rust stable (para compilar Tauri)
- Paquetes del sistema (Fedora): `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel`
- cmake (para compilar whisper.cpp)

### Ejecución en desarrollo

```bash
# Install dependencies
cd shell && pnpm install
cd ../agent && pnpm install

# Run Tauri app (Gateway + Agent auto-spawn)
cd ../shell && pnpm run tauri dev
```

Cuando la aplicación se ejecuta, automáticamente:
1. Comprobación de salud de Naia Gateway — si está en ejecución, se reutiliza; si no, se hace spawn automático
2. Spawn de Agent Core (Node.js, conexión stdio)
3. Al cerrar la aplicación, solo se termina el Gateway que se hizo spawn automáticamente

### Pruebas

```bash
cd shell && pnpm test                # Shell unit tests
cd agent && pnpm test                # Agent unit tests
cd agent && pnpm exec tsc --noEmit   # Type check
cargo test --manifest-path shell/src-tauri/Cargo.toml  # Rust tests

# E2E (Gateway + API key required)
cd shell && pnpm run test:e2e:tauri
```

### Build de Flatpak

```bash
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08
flatpak-builder --user --install --force-clean build-dir flatpak/io.nextain.naia.yml
flatpak run io.nextain.naia
```

## Modelo de seguridad

Naia aplica un modelo de seguridad de **defensa en profundidad (Defense in Depth)**:

| Capa | Protección |
|-------|-----------|
| SO | rootfs inmutable de Bazzite + SELinux |
| Gateway | Autenticación de dispositivo de OpenClaw + alcance de tokens |
| Agent | Permisos de 4 niveles (T0~T3) + bloqueo por herramienta |
| Shell | Modal de aprobación del usuario + interruptor ON/OFF por herramienta |
| Audit | Registro de auditoría SQLite (registro de toda ejecución de herramientas) |

## Sistema de memoria

Naia recuerda más allá de las sesiones con el **Alpha Memory System** — una arquitectura de 4 stores inspirada en la memoria humana:

| Store | Equivalencia | Lo que almacena |
|-------|--------|----------------|
| **Episodes** | Hipocampo | Turnos de conversación con marca de tiempo |
| **Facts** | Neocórtex | Hechos extraídos, preferencias, entidades |
| **Reflections** | Ganglios basales | Estrategias aprendidas de fallos pasados |
| **Working Memory** | Corteza prefrontal | Contexto activo de la sesión actual |

**Cómo funciona:**
1. Todos los mensajes se puntúan por importancia (novedad, relevancia, peso emocional)
2. El contenido de alta importancia se almacena como **episode**
3. Cada 30 minutos (o 5 minutos después si hay inactividad) los episodes se consolidan en **facts** (la IA "revisa ese día")
4. Al inicio de cada sesión, los facts y episodes relevantes se inyectan como contexto

**Tu memoria es tuya:**
- Almacenada localmente en `~/.naia/memory/alpha-memory.json`
- No se envía a ningún servidor — ni siquiera a Nextain
- Consulta y elimina facts en cualquier momento desde **Configuración → Memoria**
- Basta con copiar el archivo para tener una copia de seguridad

Para la guía de usuario completa, consulta [docs/memory.md](../docs/memory.md).

## Estado actual

| Fase | Descripción | Estado |
|-------|-------------|--------|
| 0 | Pipeline de distribución (BlueBuild -> ISO) | ✅ Completado |
| 1 | Integración de avatar (renderizado VRM 3D) | ✅ Completado |
| 2 | Conversación (texto/voz + sincronización labial + emociones) | ✅ Completado |
| 3 | Ejecución de herramientas (8 herramientas + permisos + auditoría) | ✅ Completado |
| 4 | Demonio de funcionamiento permanente (Gateway + Skills + Memory + Discord) | ✅ Completado |
| 5 | Integración de cuenta Nextain (OAuth + créditos + proxy de LLM) | ✅ Completado |
| 6 | Distribución de la aplicación Tauri (Flatpak/DEB/RPM/AppImage) | ✅ Completado |
| 7 | Imagen ISO del SO (arranque USB -> instalación -> SO de IA) | ✅ Completado |

## Descargas

**[Descargar Naia](https://naia.nextain.io/en/download)** — ISO, Flatpak, AppImage, DEB, RPM

| Formato | Descripción |
|--------|-------------|
| **Naia OS (ISO)** | SO de IA completo — arranque USB, instalación en disco duro (~7,2 GB) |
| Flatpak / AppImage | Solo la aplicación Naia Shell (para Linux existente) |
| DEB / RPM | Para Debian/Ubuntu o Fedora/openSUSE |

## Actualizaciones del SO

Naia OS está construido sobre [Bazzite](https://github.com/ublue-os/bazzite) (Fedora Atomic). Las actualizaciones son **atómicas y seguras**:

- **Automáticas**: una reconstrucción semanal incorpora los últimos parches de seguridad y actualizaciones de Bazzite
- **Atómicas**: la nueva imagen se despliega junto a la imagen actual — si falla, la imagen existente queda intacta
- **Rollback**: selecciona una versión anterior en el menú de GRUB para recuperarte al instante
- **Nuestra capa de superposición**: solo añade paquetes (fcitx5, fuentes) + Naia Shell (Flatpak, sandbox) + configuración de marca — nunca toca el núcleo del kernel, el cargador de arranque ni systemd

```
Bazzite base update → Weekly auto-rebuild → Container smoke test → ISO rebuild → R2 upload
                                                                 ↘ GHCR push → user bootc update
```

Detalles del pipeline de actualización: [`.agents/context/update-pipeline.yaml`](../.agents/context/update-pipeline.yaml)

## Proceso de desarrollo

### Desarrollo de funciones (predeterminado) — desarrollo basado en issues

```
ISSUE → UNDERSTAND → SCOPE → INVESTIGATE → PLAN → BUILD → REVIEW → E2E → SYNC → COMMIT
```

- **3 puertas obligatorias** — se requiere confirmación del usuario en UNDERSTAND, SCOPE y PLAN
- **Tras la aprobación del plan** — la IA ejecuta de forma continua desde BUILD hasta COMMIT sin detenerse
- **Principios** — leer primero el código upstream (sin suposiciones). Cambios mínimos. Nunca romper código que funciona.
- **Commits** — en inglés, `<type>(<scope>): <description>`
- **Formateador** — Biome (tabulaciones, comillas dobles, punto y coma)

## Documentación

Los documentos de contexto se mantienen con una estructura triple-mirror:

| Capa | Ruta | Idioma | Uso |
|-------|------|----------|---------|
| Contexto de IA | `.agents/context/` | Inglés (YAML/JSON) | Optimizado en tokens para agentes de IA |
| Documentos para humanos (EN) | `.users/context/` | Inglés (Markdown) | Documentación en inglés (predeterminada) |
| Documentos para humanos (KO) | `.users/context/ko/` | Coreano (Markdown) | Documentación en coreano |

Documentos principales:
- [Guía de rebranding de Bazzite](../.users/context/bazzite-rebranding.md) — cómo reemplazar toda la marca de Bazzite/Fedora
- [Guía de contribución](../.users/context/contributing.md) — cómo contribuir (agentes de IA y personas)
- [Filosofía](../.users/context/philosophy.md) — principios centrales (soberanía de IA, privacidad, transparencia)

## Proyectos de referencia

| Proyecto | Lo que tomamos |
|---------|-------------|
| [Bazzite](https://github.com/ublue-os/bazzite) | SO Linux inmutable, GPU, optimización para juegos |
| [OpenClaw](https://github.com/steipete/openclaw) | Demonio Gateway, integración de canales, Skills |
| [Project AIRI](https://github.com/moeru-ai/airi) | Avatar VRM, protocolo de plugins (también inspiración de Neuro-sama) |
| [OpenCode](https://github.com/anomalyco/opencode) | Separación cliente/servidor, abstracción de proveedores |
| [Careti](https://github.com/caretive-ai/careti) | Conexión de LLM, conjunto de herramientas, subagentes, gestión de contexto |
| [Neuro-sama](https://vedal.ai/) | Inspiración de IA VTuber — un personaje de IA con personalidad, streaming e interacción con la audiencia |

Naia existe gracias a estos proyectos. Agradecemos profundamente a todos los mantenedores y comunidades de código abierto que crearon los cimientos sobre los que nos apoyamos.


<a id="ai-native-open-source"></a>
## Código abierto AI-Native

En 2025–2026, la mayoría de los proyectos de código abierto se *defienden* de las contribuciones de IA. **Naia adopta el enfoque opuesto**: diseñamos el proyecto para que la contribución asistida por IA sea de alta calidad por defecto.

> **"No te defiendas contra la IA, diseña con la IA."**

### Cómo funciona

```
Person (any language) → AI → Git (English) → AI → Person (any language)
```

- **Escribe issues y PR en tu idioma** — la IA lo traduce todo
- **Tanto contribuidores como mantenedores usan IA** — codificación, revisión, triaje
- **El rico contexto de `.agents/`** profundiza la comprensión del proyecto por parte de la IA — cuanto mejor la comprende la IA, mayor la calidad de las contribuciones↑
- **10 tipos de contribución** — traducción, skills, funciones, bugs, código, documentación, pruebas, diseño, seguridad, contexto
- **Los registros de trabajo en tu idioma materno** — mantén un repo privado en tu propio idioma; el historial de Git se revisa con traducción de IA

Esto no es una simple política. Es arquitectura. El directorio `.agents/`, la documentación triple-mirror y las reglas de protección de licencia están todos diseñados para que la colaboración con IA sea estructural, no accidental.

Lee el modelo completo: [`open-source-operations.yaml`](../.agents/context/open-source-operations.yaml) | [Report (EN)](../docs/reports/20260307-ai-native-opensource-operations.md) | [Report (KO)](../docs/reports/20260307-ai-native-opensource-operations-ko.md)

## Contribuir

**No necesitas el permiso de nadie. Clona este repo y pregúntale a la IA.**

```bash
git clone https://github.com/nextain/naia-os.git
cd naia-os
# Open with any AI coding tool (Claude Code, Cursor, Copilot, etc.)
# Ask in your language: "What is this project and how can I help?"
```

El directorio `.agents/` contiene el contexto completo del proyecto — visión, arquitectura, hoja de ruta, reglas de contribución. Cualquier herramienta de codificación de IA puede leerlo y guiarte **en tu idioma**.

Escribe issues, PR y comentarios **en cualquier idioma**. Lo entendemos todo con IA.

Para más detalles, consulta [CONTRIBUTING.md](../CONTRIBUTING.md).

## Contribuidores

| Contribuidor | Contribución | Fecha |
|-------------|-------------|------|
| <img src="https://github.com/leonardo-gonc.png" width="20"> [@leonardo-gonc](https://github.com/leonardo-gonc) | Revisión nativa en portugués (PT) — documentos de contexto | 2026-03-07 |

¿Quieres ver tu nombre aquí? Consulta la [guía de contribución](../.users/context/contributing.md) y [TRANSLATING.md](../TRANSLATING.md).

## Licencia

- **Código fuente**: [Apache License 2.0](../LICENSE) — Copyright 2026 Nextain
- **Contexto de IA** (`.agents/`, `.users/`, `AGENTS.md`): [CC-BY-SA 4.0](../CONTEXT-LICENSE)

**¿Por qué licencia dual?** El código fuente es modificable libremente bajo Apache 2.0. Sin embargo, los archivos de contexto de IA — la filosofía del proyecto, la estructura de contribución, los principios de colaboración de los agentes de IA — están licenciados bajo CC-BY-SA 4.0. Es decir, si haces un fork de este proyecto:

- **Debes mantener** la misma licencia CC-BY-SA 4.0 en los archivos de contexto
- **Debes atribuir** al autor original (Nextain)
- **Puedes** modificar el contexto, **pero** los cambios deben permanecer bajo CC-BY-SA 4.0
- El modelo de contribución de código abierto y la estructura de colaboración de agentes de IA se preservan a través de todos los forks

Esto protege el ecosistema upstream. En la era del vibe coding, el contexto de IA es tan valioso como el código — mantenerlo de código abierto beneficia a toda la comunidad.

Para más detalles, consulta [CONTEXT-LICENSE](../CONTEXT-LICENSE). Los agentes de IA que trabajan en este proyecto están sujetos a las [reglas de protección de licencia](../.agents/context/agents-rules.json) y pueden verificarse con los [escenarios de prueba de protección de licencia](../.agents/tests/license-protection-test.md).

## Enlaces

- **Sitio oficial:** [naia.nextain.io](https://naia.nextain.io)
- **Manual:** [naia.nextain.io/en/manual](https://naia.nextain.io/en/manual)
- **Panel:** [naia.nextain.io/en/dashboard](https://naia.nextain.io/en/dashboard)
