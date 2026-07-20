# 議곕┰ 留ㅽ듃由?뒪 (assembly matrix) ???댁떇쨌蹂댁땐쨌?섏쭅쨌?섑룊 ?꾩닔 異붿쟻 SoT (2026-06-10, v2)

> **紐⑹쟻 = drift/?쒕∼ 諛⑹? anchor.** v1??"?먮━留? ?곴퀬 誘몃텇瑜?0??嫄곗쭞 二쇱옣(codex HIGH) ??v2??**UC1~15 + S01~71 ?꾩닔 遺꾨쪟**(誘몃텇瑜?0 *湲곌퀎 媛뺤젣* via `scripts/check-assembly-coverage.mjs`). AI ?먮떒 紐?誘우쓬 ??寃곗젙濡?泥댄겕媛 ?듭빱([[project_drift_detection_anchor_thesis]]).
> 吏꾩떎=?ъ슜???쒕굹由ъ삤(UC); ???숈옉? *留욌뜕 怨노쭔* 李몄“.

## 異?(吏곴탳 ??????
- **?섏쭅=UC** / **?섑룊=?ы듃 canon ?꾩껜(?쒖뒪???명꽣?섏씠?? ?ㅼ쨷 ?대씪?댁뼵??**.
- **?댁떇**(?쏄쾬 留욊쾶 ??/**蹂댁땐**(?녾굅??源⑥쭚)/**rejected**(?댁떇 ?쒖쇅).
- **沅뚯쐞**: `old-auth`(??*愿痢??됰룞* 湲곗?, 援ъ“???몄? ?ы듃 ?ы몴?? / `scenario-auth`(UC 湲곗?, ?쏄쾬怨??щ씪????.
- **?몄? ?ы듃 留ㅽ븨 + fit**: clean / **mismatch**(1湲??쒕㈃?? / 誘명룊媛.

## ?꾩옱 ?쒖꽦 ?щ씪?댁뒪
- **?쒖꽦 = UC1** (?띿뒪?????. ?쒖꽦 ?щ씪?댁뒪??fit=誘명룊媛 backlog ??check 媛 *媛?쒗솕*(?곴뎄 ???湲덉?, GLM 3李?C-1). 吏꾩쟾 ?놁씠 臾댄븳 pending 湲덉? ???쒖꽦? ??긽 紐낆떆.

## fit 寃뚯씠??(?대묠 ??codex HIGH ?뺤젙)
- `誘명룊媛`??**?곹깭 ??{pending, 怨꾩빟} ?먯꽌留??덉슜.** ?곹깭瑜?`肄붾뱶`/`寃利??쇰줈 ?щ━?ㅻ㈃ fit ??{clean, mismatch-resolved} **?꾩닔**. 利?**誘명룊媛??梨??щ씪?댁뒪 done 湲덉?.**
- `mismatch` 諛쒓껄 = ?됱뿉 **?닿껐寃쎈줈 紐낆떆**(=(a) UC ?몄??먮쫫 ?щℓ??/ (b) ?섑룊 媛??ш??? + 誘명빐寃???洹??щ씪?댁뒪 commit 李⑤떒.
- **湲곌퀎 媛뺤젣**: `scripts/check-assembly-coverage.mjs` = ??user-scenarios??紐⑤뱺 UC/S媛 ???쒖뿉 ?덈굹(誘몃텇瑜?0) ???곹깭?μ퐫?쒖씤??fit=誘명룊媛????0. ?꾨컲=鍮? exit.

---

## ?섑룊 ?몃옓 ???ы듃 canon ?꾩껜 (?ㅼ쨷 ?대씪?댁뼵?맞룸떎以?UC 怨듯넻, AppPort ?ы씉??湲덉?)
| # | ?ы듃/諛곗꽑 | ??븷 | old | ?댁떇/蹂댁땐 | 沅뚯쐞 | ?곹깭(slice) |
|---|---|---|---|---|---|---|
| H-proto | `protocol` | transport-neutral ?섎? DTO(吏곷젹???꾩텧 湲덉?) | ?녹궛??| 蹂댁땐 | scenario | 遺遺?F0)쨌?쇰컲???꾩슂 |
| H-tx | transport ?대뙌??| stdio(now)?뭛RPC(紐⑺몴), ?대뙌??援먯껜 | O(stdio) | ?댁떇+蹂댁땐 | old(stdio)/scen(gRPC) | pending |
| H-client | `ClientSessionPort` | ?ㅼ쨷 ?대씪?댁뼵???좎썝쨌lease쨌arbitration | ??| 蹂댁땐 | scenario | pending(UC10a) |
| H-safety | `SafetyPort` | e-stop쨌lease revoke쨌媛뺣벑(reactive) | ??| 蹂댁땐 | scenario | pending(UC13a) |
| H-app | `AppPort`(=ChatPort+ToolPort *議곕┰ facade*, ?ы씉???꾨떂) | facade | ??| 蹂댁땐 | scenario | pending |
| H-chat | `ChatPort` | ???ingress(?낅┰) | O transport?숈옉쨌**異붿긽???놁쓬**(shell?봗auri 吏곴껐) | ?댁떇(?먮쫫)+蹂댁땐(異붿긽?? | old-auth(?먮쫫) | pending(UC1) |
| H-tool | `ToolPort` | ??interaction(?낅┰) | ?녹쭅?묓샇異?| 蹂댁땐 | scenario | pending(UC5) |
| H-sensory | `SensoryPort` | 媛먭컖(audio/vision/screen) | O(遺遺? | ?댁떇+蹂댁땐 | mixed | pending(UC2/61) |
| H-intero | `InteroceptivePort` | ?댁닔???쒖뒪???곹깭) | O | ?댁떇 | old | **F1 怨꾩빟+肄붾뱶** |
| H-express | `ExpressionPort` | ?쒗쁽(speak/emote, embodiment-neutral) | ??UI吏곴껐) | 蹂댁땐 | scenario | pending(UC1/2) |
| H-env | `EnvironmentPort`(observe/act/space/app-surface/host) | ?섍꼍 愿痢≤룻뻾??| O | ?댁떇 | old | **F2(observe)+F3(mutate) 怨꾩빟+肄붾뱶**; app-surface/space pending |
| H-approval | `ApprovalPort` | ?뱀씤 寃뚯씠??寃곗냽 | O(遺遺? | ?댁떇+蹂댁땐 | mixed | **F1 怨꾩빟+肄붾뱶** |
| H-proprio | `ProprioceptivePort` | 怨좎쑀?섏슜(?먯꽭쨌愿?댟톝elf/body model) | ??| 蹂댁땐 | scenario | pending(2?④퀎쨌濡쒕큸) |
| H-action | `ActionPort` | ?됱쐞(body ?대룞쨌議곗옉쨌?뚯?) | ??| 蹂댁땐 | scenario | pending(2?④퀎쨌濡쒕큸) |
| H-cron | `CronPort` | temporal ?묒뾽 ?ㅼ?以?| ??誘몃퉴?? | 蹂댁땐 | scenario | pending(2?④퀎) |
| **H-agent** | **agent(brain)?봮s ?곌껐** | stdio JSON-line(send_to_agent_command?봞gent_response) | **湲곕낯 chat=O ?숈옉(?댁떇)**; 源딆? ?듯빀(memory/context)=蹂댁땐 | ?댁떇(chat I/O)+蹂댁땐(deep) | old-auth(chat)/scenario(deep) | chat ?숈옉쨌**ChatPort 異붿긽???놁쓬** |

> ?좑툘 v1泥섎읆 "protocol?묨ppPort ?⑥씪寃쎈줈"濡?醫곹엳吏 ?딆쓬. AppPort=Chat/Tool ?섎굹??肉? ?섎㉧吏 ?ы듃???낅┰(canon: Sensory쨌Interoceptive쨌**Proprioceptive**쨌Chat쨌Express쨌Environment쨌**Action**쨌Approval쨌ClientSession쨌Safety쨌Cron). ?ㅼ쨷 ?대씪?댁뼵??H-client. (GLM 3李? Proprioceptive쨌Action쨌Cron ?꾨씫 ?뺤젙.)

---

## ?섏쭅 UC ?몃옓 ??UC1~15 ?꾩닔 (遺꾨쪟; UC1 ?곸꽭)

| UC | ?댁떇/蹂댁땐 | 二??몄??ы듃 | 沅뚯쐞 | slice/?곹깭 |
|---|---|---|---|---|
| **UC1** ?띿뒪?몃???| **?댁떇**(梨꾪똿 ?숈옉)+蹂댁땐(ChatPort 異붿긽?? | Chat?뭓gent?묮xpress | old-auth(?먮쫫) | ???곸꽭 |
| UC2 ?뚯꽦???| ?댁떇+蹂댁땐 | Sensory?믠╈넂Express(avatar) | mixed(?몃??? | pending(?꾩냽 tranche) |
| UC3 湲곗뼲???| **蹂댁땐** | Chat+memory | scenario | pending(naia-memory ?몃옓) |
| UC4 ?λ룞?뚯긽 | **蹂댁땐** | memory+temporal | scenario | pending |
| UC5 ?꾧뎄?ъ슜 | ?댁떇 | ToolPort+Environment | old | pending |
| UC6 ?섍꼍議곗옉-釉뚮씪?곗? | ?댁떇 | EnvironmentPort(app-surface) | old | pending |
| UC7a ?쒖뒪?쒓?痢?| ?댁떇 | EnvironmentPort observe | old | **F2 怨꾩빟+肄붾뱶** |
| UC7 ?쒖뒪?쒖“??| ?댁떇+蹂댁땐 | EnvironmentPort act+reafference | mixed | **F3 怨꾩빟+肄붾뱶** |
| UC8 怨듦컙遺꾩쐞湲?| ?댁떇 | EnvironmentPort(space) | old | pending |
| UC9 ?⑤꼸??| ?댁떇 | EnvironmentPort(app-surface) | old | pending |
| UC10 硫?곗콈??| ?댁떇+蹂댁땐 | (梨꾨꼸 ingress) | mixed | pending(S36 源⑥쭚) |
| UC10a ?ㅼ쨷?대씪?댁뼵??| **蹂댁땐** | ClientSessionPort | scenario | pending(H-client) |
| UC11 ?먭린?곹깭 | ?댁떇 | InteroceptivePort?묮xpress | old | **F1 怨꾩빟+肄붾뱶** |
| UC12-min 理쒖냼遺??| ?댁떇 | control-plane | old | **F0 怨꾩빟+肄붾뱶** |
| UC12 ?⑤낫???ㅼ젙 | ?댁떇 | control-plane(session/auth) | old | 遺遺?F0)쨌?몃?auth pending |
| UC12a ?ㅼ젙寃利?| 蹂댁땐 | InteroceptivePort | scenario | **F1 ?≪닔** |
| UC13 ?뱀씤寃뚯씠??| ?댁떇+蹂댁땐 | ApprovalPort | mixed | **F1 怨꾩빟+肄붾뱶** |
| UC13a 以묐떒/e-stop | **蹂댁땐** | SafetyPort | scenario | pending(H-safety) |
| UC14 degradation | **蹂댁땐** | InteroceptivePort?묮xpress | scenario | **F1(?뺤쭅 degradation ?좎꽕)** |
| UC15 continuous speech stream | 보충 | H-agent+H-tx+ExpressionPort+SafetyPort | scenario | pending(#82 cross-repo; Rust/Tauri activity stream tests planned) |

### UC1 ?곸꽭 ???띿뒪?????(Chat?믪궗怨졻넂?쒗쁽)
| # | 議곌컖(S) | old | ?댁떇/蹂댁땐 | ?몄? ?ы듃 | fit | 沅뚯쐞 | ?곹깭 |
|---|---|---|---|---|---|---|---|
| U1.1 | S13 梨꾪똿 ?낅젰 UI | O(shell) | ?댁떇 | ChatPort(ingress) | 誘명룊媛 | old-auth | pending |
| U1.2 | LLM ?ш퀬/異붾줎 | **O ?숈옉**(shell?뭩tdio?뭓gent?뭦rovider.chat ?ㅽ듃由щ컢) | ?댁떇(?먮쫫)+蹂댁땐(ChatPort 異붿긽?? | agent(brain) via H-chat/H-app | 誘명룊媛 | old-auth(?먮쫫 ?숈옉) | pending |
| U1.3a | ?묐떟 *?띿뒪???쒖떆* UI | O(shell) | ?댁떇 | (shell ?뚮뜑) ??Express 異쒕젰 ?뚮퉬 | 誘명룊媛 | old-auth | pending |
| U1.3b | ?묐떟 *speech-intent* | ??| **蹂댁땐** | ExpressionPort(embodiment-neutral) | 誘명룊媛 | scenario-auth | pending |
| U1.4 | S62 @硫섏뀡 ?뚯씪?좏깮 | O(shell) | ?댁떇 | ChatPort + EnvironmentPort observe | 誘명룊媛 | old-auth | pending |
| U1.5 | S70 ?뚯씪 deeplink (UC1/UC7 怨듭쑀) | O(shell) | ?댁떇 | ChatPort + EnvironmentPort **app-surface ?됱쐞**(?⑤꼸 open/?꾪솚) | 誘명룊媛 | old-auth | pending |
| U1.6a | S03 provider ?ㅼ젙 UI (UC12 怨듭쑀) | O | ?댁떇 | control-plane/config | 誘명룊媛 | old-auth | pending(F0 ?몄젒, 誘몄륫?? |
| U1.6b | S03 provider?뭓gent ?곌껐/寃利?| O ?숈옉(creds_update쨌chat_request provider) | ?댁떇 | control-plane?뭓gent | 誘명룊媛 | old-auth | pending |


> **UC1 grounding (2026-06-10, Explore ?ㅼ퐫??:** ????梨꾪똿 *?숈옉?? ??`ChatPanel?뭖hat-service.sendChatMessage?뭝nvoke("send_to_agent_command")?뭩tdio?뭓gent index.ts handleChatRequest?뭦rovider.chat() ?ㅽ듃由щ컢??agent_response" event?뭜andleChunk`. transport=**stdio JSON-line**(gRPC 0). DTO=`protocol.ts` ChatRequest/AgentResponseChunk(?댁떇 媛??. **ChatPort/AppPort 異붿긽???놁쓬**(shell?봳ransport 吏곴껐)=蹂댁땐. 猷⑦겕 "agent 誘몄뿰寃?=memory/源딆??듯빀(UC3+)?댁? *湲곕낯 chat ?꾨떂*. ??**UC1 ?섑룊 = ?숈옉?섎뒗 ?먮쫫??ChatPort/protocol(transport-neutral)濡?*?ы몴??(?댁떇) + gRPC=?대뙌??援먯껜**. scenario-auth ?꾨떂(old ?숈옉 湲곗?).

**UC1 李⑹닔**: ?섑룊 H-proto쨌H-tx쨌H-app쨌**H-agent** 癒쇱?(agent ?곌껐 *?쒕?濡?) ??U1.1?뭊1.2?뭊1.3a/b ?ы몴????린 ??mismatch=?쒕㈃???곌? 湲덉?) ??U1.4~U1.6.

---

## S ?꾩닔 遺꾨쪟 (S01~71 ??per-S ?뚯씠釉? ?됰떒??誘몃텇瑜?0; 湲곌퀎 寃利????
> GLM 3李? 遺덈┸ 洹몃９?묒? S蹂??댁떇/蹂댁땐쨌multi-UC瑜??먮┝ ??per-S ?됱쑝濡??꾪솚. 媛??됱뿉 ?댁떇/蹂댁땐/rej쨌UC(??쨌?ы듃쨌沅뚯쐞 ?꾩닔.

| S | 湲곕뒫 | UC(?? | ?댁떇/蹂댁땐/rej | 二??ы듃 | 沅뚯쐞 | ?곹깭 |
|---|---|---|---|---|---|---|
| S01 | ?⑤낫??welcome | UC12 | ?댁떇 | control-plane | old-auth | pending |
| S02 | ?ㅼ젙/settings ?⑤꼸 | UC12 | ?댁떇 | control-plane | old-auth | pending |
| S03 | provider ?ㅼ젙 | UC12쨌UC1 | ?댁떇 | control-plane (?곌껐=H-agent 蹂댁땐) | old-auth | pending(蹂듭옟쨌誘몄륫?? |
| S04 | naia 怨꾩젙/api key | UC12 | ?댁떇 | control-plane | old-auth | pending |
| S05 | sessions 愿由?| UC12 | ?댁떇 | ClientSessionPort/control | old-auth | pending |
| S06 | agents 愿由?| UC12 | ?댁떇 | control-plane쨌skill | old-auth | pending |
| S07 | skill-manager | UC12쨌skill | ?댁떇 | ToolPort쨌EnvironmentPort(exec) | old-auth | pending(F3 ?몄젒) |
| S08 | notify-config | UC12 | ?댁떇 | control-plane | old-auth | pending |
| S09 | system-status | UC11 | ?댁떇 | InteroceptivePort | old-auth | F1 怨꾩빟+肄붾뱶 |
| S10 | diagnostics | UC11 | ?댁떇 | InteroceptivePort | old-auth | F1 怨꾩빟+肄붾뱶 |
| S11 | device ?곹깭/?쒖뼱 | UC11쨌UC7 | ?댁떇 | InteroceptivePort쨌EnvironmentPort | old-auth | F1(遺遺? |
| S12 | approvals ?뱀씤 | UC13 | ?댁떇+蹂댁땐 | ApprovalPort | mixed | F1 怨꾩빟+肄붾뱶 |
| S13 | ?띿뒪?????| UC1 | ?댁떇+蹂댁땐 | ChatPort(UI ?댁떇)쨌llm/agent쨌ExpressionPort(蹂댁땐) | old-auth(UI)/scenario(agent쨌Express) | pending |
| S14 | omni ?뚯꽦 | UC2 | ?댁떇+蹂댁땐 | SensoryPort쨌voice | mixed | pending(?몃??? |
| S15 | gemini-live ?뚯꽦 | UC2 | ?댁떇 | SensoryPort쨌voice | mixed | pending(?몃??? |
| S16 | openai-realtime ?뚯꽦 | UC2 | ?댁떇 | SensoryPort쨌voice | mixed | pending(?몃??? |
| S17 | tts | UC2 | ?댁떇 | ExpressionPort(speech) | old-auth | pending |
| S18 | voicewake | UC2 | ?댁떇 | SensoryPort쨌wake | old-auth(?붿옱쨌誘멸?利? | pending |
| S19 | avatar ?쒗쁽 | UC2 | ?댁떇 | ExpressionPort(avatar) | old-auth | pending |
| S20 | time | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S21 | weather | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S22 | memo | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S23 | github skill | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S24 | obsidian skill | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S25 | mcp ?곌껐 | UC5 | ?댁떇 | ToolPort | old-auth | pending |
| S26 | agent-browser | UC6 | ?댁떇 | EnvironmentPort(app-surface) | old-auth | pending |
| S27 | browser ?⑤꼸 | UC6 | ?댁떇 | EnvironmentPort(app-surface) | old-auth | pending |
| S28 | panel ?ㅼ튂 | UC9 | ?댁떇 | EnvironmentPort(app-surface) | old-auth | pending |
| S29 | generic-installed ?⑤꼸 | UC9 | ?댁떇 | EnvironmentPort(app-surface) | old-auth | pending |
| S30 | sample-note ?⑤꼸 | UC9 | rejected | ??| ??| rejected(?쒓굅?? |
| S31 | youtube-bgm | UC8 | ?댁떇 | EnvironmentPort(space) | old-auth | pending |
| S32 | 諛곌꼍?붾㈃/scene | UC8 | ?댁떇 | EnvironmentPort(space) | old-auth | pending |
| S33 | workspace(fs쨌editor쨌filetree) | UC7 | ?댁떇 | EnvironmentPort(observe+act) | old-auth | F2(observe)+F3(act) |
| S34 | terminal(pty) | UC7 | ?댁떇 | EnvironmentPort(observe+act) | old-auth | F2+F3(遺遺? |
| S35 | channels ?쇰컲 | UC10 | ?댁떇+蹂댁땐 | (梨꾨꼸 ingress) | mixed | pending |
| S36 | naia-discord | UC10 | 蹂댁땐 | (梨꾨꼸) | scenario-auth | pending(源⑥쭚) |
| S37 | notify-discord | UC10 | ?댁떇 | (notify) | old-auth | pending |
| S38 | notify-google-chat | UC10 | ?댁떇 | (notify) | old-auth | pending |
| S39 | notify-slack | UC10 | ?댁떇 | (notify) | old-auth | pending |
| S41 | 湲곗뼲 recall/二쇱엯 | UC3 | ?댁떇+蹂댁땐 | memory쨌scrubber(scrubber ?댁떇, recall 蹂댁땐) | mixed | pending(recall 誘몃같?? |
| S42 | ?λ룞 ?뚯긽 | UC4 | 蹂댁땐 | memory쨌CronPort | scenario-auth | pending(誘몃같?? |
| S43 | cron ?묒뾽 | temporal쨌UC4 | 蹂댁땐 | CronPort | scenario-auth | pending(誘몃퉴?? scaffold 諛쒓껄 ???댁떇+蹂댁땐 ?ы룊媛) |
| S44 | graceful degradation | UC14 | 蹂댁땐 | InteroceptivePort쨌ExpressionPort | scenario-auth | F1(?좎꽕) |
| S45 | ?ㅽ뻾 以?以묐떒/e-stop | UC13a | 蹂댁땐 | SafetyPort | scenario-auth | pending |
| S46 | ?ㅼ쨷 ?대씪?댁뼵??異⑸룎 | UC10a | 蹂댁땐 | ClientSessionPort | scenario-auth | pending |
| S47 | ?섎Ⅴ?뚮굹/personality | UC12쨌?쒗쁽 | ?댁떇 | control-plane쨌ExpressionPort | old-auth | pending |
| S48 | 濡쒖뺄 ?ㅽ궗 濡쒕뵫쨌?뺤옣 | UC5쨌skill | ?댁떇+蹂댁땐 | ToolPort쨌EnvironmentPort(loader ?댁떇, ?뺤옣諛곗꽑 蹂댁땐) | mixed | pending(諛곗꽑?섏〈) |
| S49 | STT 紐⑤뜽 愿由?| UC2 | ?댁떇 | SensoryPort쨌adapter | old-auth | pending |
| S50 | ?ㅻ뵒??異쒕젰 ?μ튂 | UC2 | ?댁떇 | (?④낵湲?audio) | old-auth | pending |
| S51 | gateway ?댁쁺 | control-plane | ?댁떇 | control-plane | old-auth | pending |
| S52 | memory facts CRUD | UC3 | ?댁떇 | memory(facts) | old-auth | pending |
| S52b | 硫붾え由?諛깆뾽/蹂듭썝 | UC3 | ?댁떇 | memory | old-auth | pending |
| S53 | audit log | control-plane | ?댁떇 | control-plane | old-auth | pending |
| S54 | OAuth/濡쒓렇?맞톕ey 寃利?| UC12 | ?댁떇+蹂댁땐 | control-plane(auth) | mixed | pending(?몃?auth) |
| S55 | gateway ?ㅽ궗(web_search쨌x쨌discord) | UC5쨌UC10 | ?댁떇 | ToolPort(gateway) | old-auth | pending |
| S56 | external 愿묎퀬 tool | UC5 | ?댁떇 | ToolPort(gateway/mcp) | old-auth | pending |
| S57 | ADK 遺?몄뒪?몃옪 | UC12 | ?댁떇 | control-plane | old-auth | F0 怨꾩빟+肄붾뱶 |
| S58 | 鍮꾩슜 ??쒕낫?쑣룹옍??| UC12 | ?댁떇 | control-plane | old-auth | pending |
| S59 | ???낅뜲?댄듃 ?뚮┝/?ㅼ튂 | control-plane | ?댁떇 | control-plane | old-auth | pending |
| S60 | ?먭꺽 怨듭? 諛곕꼫 | control-plane | ?댁떇 | control-plane | old-auth | pending |
| S61 | ?붾㈃/?⑤꼸 鍮꾩쟾 罹≪쿂 | UC11쨌UC6 | ?댁떇 | SensoryPort(vision) | old-auth | pending |
| S62 | 梨꾪똿 @硫섏뀡 ?뚯씪?좏깮 | UC1 | ?댁떇 | ChatPort쨌EnvironmentPort(observe) | old-auth | pending |
| S63 | GitHub Issues ?⑤꼸 | UC5쨌UC7 | ?댁떇 | ToolPort쨌EnvironmentPort | old-auth | pending |
| S64 | ModeBar 釉뚮씪?곗? 諛붾줈媛湲?| UC6 | ?댁떇 | EnvironmentPort(app-surface) | old-auth | pending |
| S65 | botmadang ?곕룞 | UC10쨌UC5 | rejected | ??| ??| rejected(猷⑦겕 寃곗젙) |
| S66 | 李몄“ ?ㅻ뵒??voice clone | UC2 | ?댁떇 | voice쨌ExpressionPort(timbre) | old-auth | pending |
| S67 | Naia Lab ?ㅼ젙 ?숆린??| UC12 | ?댁떇 | control-plane | old-auth | pending |
| S70 | 梨꾪똿 ?뚯씪 deeplink | UC1쨌UC7 | ?댁떇 | ChatPort쨌EnvironmentPort(app-surface ?됱쐞) | old-auth | pending |
| S71 | 踰덈뱾 default-skills(~60+, OpenClaw) | UC5쨌skill | ?댁떇 | ToolPort/SkillPort쨌gateway | old-auth | pending(per-skill 寃利? |

> (S40쨌S68쨌S69 = user-scenarios ?몃깽?좊━???놁쓬/諛고룷 out-of-scope.)

## 媛깆떊/泥댄겕 洹쒖튃
議곌컖 ?묒뾽 ???대떦 ???곹깭쨌fit 媛깆떊, mismatch=利됱떆 湲곕줉+?닿껐寃쎈줈. **commit ??`node scripts/check-assembly-coverage.mjs` ?듦낵 ?꾩닔**(誘몃텇瑜?0 + ?곹깭?μ퐫????fit?좊??됯?). ?ㅼ쓬 UC??媛숈? ?섑룊 ?꾩뿉 ?섏쭅留?異붽?.

## 寃利??쒓퀎 (諛붿슫????4怨꾨낫 援먯감 ???뺤쭅 湲곕줉)
codex쨌gemini쨌GLM 4?쇱슫?쒕줈 *?댁슜 寃고븿*(誘몃텇瑜? 嫄곗쭞쨌?섑룊 醫곹옒쨌canon?ы듃 ?꾨씫쨌per-S ?ㅻ텇瑜샕톁71 ?꾨씫쨌H-app ?ш껐??? ?뺤젙?? ?⑥? 寃고븿 = **泥댄겕 ?ㅽ겕由쏀듃媛 prose markdown ??regex 濡?寃??*?섎뒗 ???댁옱??
- staleness 媛 ?レ옄 異쒕젰肉?湲곗??쒓컖쨌利앷?李⑤떒 ?놁쓬 ??臾댄븳 pending 媛?? ??backlog 媛?쒗솕濡?*???? 留됱븯?쇰굹 *媛뺤젣*??紐???
- per-S ??寃利앹씠 而щ읆 ?샕룹쨷蹂돠룻뀒?대툝 ?뚯냽源뚯???紐?遊?regex ?쒓퀎).
**洹쇰낯 ?닿껐(沅뚯옣, 誘몄떎??**: 留ㅽ듃由?뒪瑜?**structured-data(YAML/JSON) + schema 寃利?*?쇰줈 ??洹몃윭硫?regex ?고쉶쨌format ?꾨씫 class 媛 ??踰덉뿉 ?ロ옒. 吏湲덉? prose+regex 濡?*?곕컻???쒕∼? ?↔퀬*(誘몃텇瑜?쨌per-S 遺꾨쪟쨌fit寃뚯씠?맞룻솢?깆꽑?? 臾댄븳 ?섎뱶?앹? 諛붿슫?? AI "??異뺣쭔" 諛⑹???1李??덉쟾留앹쑝濡?異⑸텇, 2李?structured)???댁떇 吏꾪뻾?섎ŉ.
