// gRPC client — naia_agent.proto(naia-agent SoT) 에서 build.rs(tonic-build)가 생성.
// 정본 os↔agent transport = gRPC. stdio 파이프 교체. AgentEvent → UI agent_response JSON(encodeEmit 동형) 재구성.
#![allow(dead_code)]

pub mod pb {
    tonic::include_proto!("naia.agent.v1");
}

use pb::agent_event::Event;
use pb::naia_agent_client::NaiaAgentClient;
use pb::{ApprovalResponseRequest, CancelRequest, ChatRequest, CredsUpdate, Message, SetWorkspaceRequest, ToolRequestControl};
use serde_json::{json, Value};
use tonic::transport::Channel;

/// AgentEvent(proto) → UI 가 받는 agent_response JSON. protocol.ts encodeEmit 11종과 동일 형태(무회귀).
/// args/raw 는 proto 에서 JSON 문자열(args_json/raw_json) → 여기서 다시 Value 로 파싱(무손실).
pub fn agent_event_to_ui_json(ev: &pb::AgentEvent) -> Value {
    let rid = ev.request_id.clone();
    let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
    match &ev.event {
        Some(Event::Text(t)) => json!({"type":"text","requestId":rid,"text":t.text}),
        Some(Event::Thinking(t)) => json!({"type":"thinking","requestId":rid,"text":t.text}),
        Some(Event::ToolUse(t)) => json!({"type":"tool_use","requestId":rid,"toolCallId":t.tool_call_id,"toolName":t.tool_name,"args":parse(&t.args_json)}),
        Some(Event::ToolResult(t)) => json!({"type":"tool_result","requestId":rid,"toolCallId":t.tool_call_id,"output":t.output,"toolName":t.tool_name,"success":t.success}),
        Some(Event::ApprovalRequest(t)) => json!({"type":"approval_request","requestId":rid,"toolCallId":t.tool_call_id,"toolName":t.tool_name,"tier":t.tier,"args":parse(&t.args_json),"description":t.description}),
        Some(Event::GatewayApprovalRequest(t)) => json!({"type":"gateway_approval_request","requestId":rid,"toolCallId":t.tool_call_id,"toolName":t.tool_name,"args":parse(&t.args_json)}),
        Some(Event::Usage(u)) => {
            let mut o = json!({"type":"usage","requestId":rid,"inputTokens":u.input_tokens,"outputTokens":u.output_tokens});
            if let Some(c) = u.cost {
                o["cost"] = json!(c);
            }
            if let Some(m) = &u.model {
                o["model"] = json!(m);
            }
            o
        }
        Some(Event::LogEntry(l)) => json!({"type":"log_entry","requestId":rid,"level":l.level,"message":l.message}),
        Some(Event::TokenWarning(t)) => json!({"type":"token_warning","requestId":rid,"raw":parse(&t.raw_json)}),
        Some(Event::Finish(_)) => json!({"type":"finish","requestId":rid}),
        Some(Event::Error(e)) => json!({"type":"error","requestId":rid,"message":e.message}),
        Some(Event::Compacted(c)) => json!({"type":"compacted","requestId":rid,"droppedCount":c.dropped_count}), // UC-compaction(FR-COMPACT)
        Some(Event::PanelToolCall(t)) => json!({"type":"panel_tool_call","requestId":rid,"toolCallId":t.tool_call_id,"toolName":t.tool_name,"args":parse(&t.args_json)}), // UC-PANEL FR-PANEL-2: 환경 도구 위임 → 셸 실행
        None => json!({"type":"error","requestId":rid,"message":"empty AgentEvent"}),
    }
}

/// 셸이 만든 wire JSON({type:"chat_request",requestId,messages,...}) → proto ChatRequest. provider 제거(정본).
pub fn json_to_chat_request(v: &Value) -> ChatRequest {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let messages = v
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| Message {
                    role: m.get("role").and_then(|x| x.as_str()).unwrap_or("user").to_string(),
                    content: m.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    tool_call_id: m.get("toolCallId").and_then(|x| x.as_str()).map(|x| x.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    ChatRequest {
        request_id: s("requestId").unwrap_or_default(),
        session_id: s("sessionId"),
        messages,
        system_prompt: s("systemPrompt"),
        enable_tools: v.get("enableTools").and_then(|x| x.as_bool()),
        enable_thinking: v.get("enableThinking").and_then(|x| x.as_bool()),
        gateway_url: s("gatewayUrl"),
        disabled_skills: v
            .get("disabledSkills")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|x| x.to_string())).collect())
            .unwrap_or_default(),
    }
}

/// tonic 클라이언트 래퍼. lib.rs 가 spawn 한 agent(gRPC 서버)에 connect 해 사용.
/// Clone = 내부 Channel(Arc) 공유 — chat stream 을 동시 실행하려 per-요청 clone.
#[derive(Clone)]
pub struct AgentGrpc {
    client: NaiaAgentClient<Channel>,
}

impl AgentGrpc {
    pub async fn connect(addr: String) -> Result<Self, tonic::transport::Error> {
        let client = NaiaAgentClient::connect(addr).await?;
        Ok(Self { client })
    }

    pub async fn set_workspace(&mut self, adk_path: String) -> Result<pb::SetWorkspaceResult, tonic::Status> {
        Ok(self.client.set_workspace(SetWorkspaceRequest { adk_path }).await?.into_inner())
    }

    pub async fn reload_settings(&mut self) -> Result<pb::SetWorkspaceResult, tonic::Status> {
        Ok(self.client.reload_settings(pb::ReloadSettingsRequest {}).await?.into_inner())
    }

    /// UC-KNOWLEDGE-COMPILE(FR-KB-5): 설정 지식 탭 "지금 컴파일" → 등록 소스 폴더 → kb.json.
    /// naia-agent 가 naia-settings/knowledge.json 을 읽어 kb-compiler compile. 통계 반환(no-throw RPC).
    pub async fn compile_knowledge(&mut self, adk_path: String) -> Result<pb::CompileKnowledgeResult, tonic::Status> {
        Ok(self.client.compile_knowledge(pb::CompileKnowledgeRequest { adk_path }).await?.into_inner())
    }

    /// F1 rich-health(신규계약 Diagnostics RPC): agent version/uptime/components. os InteroceptivePort rich payload.
    pub async fn diagnostics(&mut self) -> Result<pb::DiagnosticsResult, tonic::Status> {
        Ok(self.client.diagnostics(pb::DiagnosticsRequest {}).await?.into_inner())
    }

    /// Chat server-stream → 각 AgentEvent 를 UI JSON 으로 emit(현 reader loop 의 agent_response 와 동일 형태).
    pub async fn chat<F: FnMut(String)>(&mut self, req: ChatRequest, mut emit: F) -> Result<(), tonic::Status> {
        let mut stream = self.client.chat(req).await?.into_inner();
        while let Some(ev) = stream.message().await? {
            emit(agent_event_to_ui_json(&ev).to_string());
        }
        Ok(())
    }

    /// 구 standalone tool_request(셸 directToolCall) — new-core 미지원 → 즉시 error 스트림(셸 120s 행 방지).
    /// 드롭하면 셸 기동 directToolCall(skill_voicewake/skill_config/skill_sessions)이 응답 없이 행한다(회귀).
    pub async fn tool_request<F: FnMut(String)>(&mut self, request_id: String, tool_name: String, mut emit: F) -> Result<(), tonic::Status> {
        let mut stream = self.client.tool_request(ToolRequestControl { request_id, tool_name }).await?.into_inner();
        while let Some(ev) = stream.message().await? {
            emit(agent_event_to_ui_json(&ev).to_string());
        }
        Ok(())
    }

    pub async fn update_creds(&mut self, provider: String, api_key: Option<String>, naia_key: Option<String>) -> Result<(), tonic::Status> {
        self.client.update_creds(CredsUpdate { provider, api_key, naia_key }).await?;
        Ok(())
    }

    pub async fn cancel(&mut self, request_id: String) -> Result<(), tonic::Status> {
        self.client.cancel(CancelRequest { request_id }).await?;
        Ok(())
    }

    pub async fn approval_response(&mut self, request_id: String, tool_call_id: String, approve: bool) -> Result<(), tonic::Status> {
        let decision = if approve {
            pb::approval_response_request::Decision::Approve
        } else {
            pb::approval_response_request::Decision::Reject
        };
        self.client
            .approval_response(ApprovalResponseRequest { request_id, tool_call_id, decision: decision as i32 })
            .await?;
        Ok(())
    }

    // UC-PANEL FR-PANEL: 환경 panel skill RPC 클라이언트(셸→agent). agent_dispatcher 가 wire JSON 을 이리로 라우팅.
    pub async fn register_panel_skills(&mut self, panel_id: String, tools: Vec<pb::ToolSpec>) -> Result<(), tonic::Status> {
        self.client.register_panel_skills(pb::PanelSkills { panel_id, tools }).await?;
        Ok(())
    }

    pub async fn clear_panel_skills(&mut self, panel_id: String) -> Result<(), tonic::Status> {
        self.client.clear_panel_skills(pb::PanelId { panel_id }).await?;
        Ok(())
    }

    pub async fn list_skills(&mut self) -> Result<pb::SkillList, tonic::Status> {
        Ok(self.client.list_skills(pb::ListSkillsRequest {}).await?.into_inner())
    }

    pub async fn panel_tool_result(&mut self, request_id: String, tool_call_id: String, output: String, success: bool) -> Result<(), tonic::Status> {
        self.client.panel_tool_result(pb::PanelToolResultMsg { request_id, tool_call_id, output, success }).await?;
        Ok(())
    }
}

// 라이브 통합 진단 — 앱/cage/wdio 없이 Rust AgentGrpc.chat 을 실 agent 에 직접 구동(SIGUSR1-free).
// RUN_LIVE_RUST_GRPC=1 일 때만. 앱의 dispatcher chat 경로(buggy 의심부)를 격리 검증.
#[cfg(test)]
mod live_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    #[tokio::test]
    async fn live_grpc_chat_roundtrip() {
        if std::env::var("RUN_LIVE_RUST_GRPC").as_deref() != Ok("1") {
            return;
        }
        // Maintainer-supplied path to the agent stdio entry (no personal default).
        let entry = std::env::var("NAIA_AGENT_ENTRY")
            .expect("set NAIA_AGENT_ENTRY to the agent-stdio-entry.mjs path for this live test");
        // agent stderr(DEBUG ingress) → 안정 파일($HOME). cargo test stdout 미포착·/tmp 소실 회피.
        let dbg_path = format!("{}/rust-grpc-agent-stderr.log", std::env::var("HOME").unwrap_or_default());
        let dbg_file = std::fs::File::create(&dbg_path).expect("dbg file");
        let mut child = Command::new("node")
            .arg(entry)
            .env("NAIA_ADK_PATH", std::env::var("NAIA_ADK_PATH").unwrap_or_default())
            .env("NAIA_AGENT_SKILLS", "off")
            .env("NAIA_AGENT_MEMORY", "off")
            .env("NAIA_AGENT_DEBUG", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::from(dbg_file))
            .spawn()
            .expect("spawn agent");
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut addr = String::new();
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if let Some(x) = line.strip_prefix("GRPC_LISTENING ") {
                addr = x.trim().to_string();
                break;
            }
            line.clear();
        }
        assert!(!addr.is_empty(), "GRPC_LISTENING addr");
        let mut client = AgentGrpc::connect(format!("http://{}", addr)).await.expect("connect");
        let sw = client.set_workspace(std::env::var("NAIA_ADK_PATH").unwrap_or_default()).await.expect("set_workspace");
        eprintln!("[RUST-GRPC-TEST] SetWorkspace loaded={} {}/{}", sw.loaded, sw.provider, sw.model);
        let req = json_to_chat_request(&serde_json::json!({
            "requestId": "rust-t1",
            "messages": [{ "role": "user", "content": "한 문장으로 인사해줘" }]
        }));
        let mut text = String::new();
        let mut tokens: i64 = 0;
        let mut err: Option<String> = None;
        // 30s 타임아웃 — chat 이 행하면 테스트를 행시키지 말고 명확히 실패시킨다(행 vs 응답 결정 판별).
        let chat_res = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            client.chat(req, |json| {
                let v: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
                match v["type"].as_str() {
                    Some("text") => text.push_str(v["text"].as_str().unwrap_or("")),
                    Some("usage") => tokens = v["inputTokens"].as_i64().unwrap_or(0) + v["outputTokens"].as_i64().unwrap_or(0),
                    Some("error") => err = Some(v["message"].as_str().unwrap_or("").to_string()),
                    _ => {}
                }
            }),
        )
        .await;
        let _ = child.kill();
        let chat_state = match &chat_res {
            Err(_) => "TIMEOUT-30s(chat hang)".to_string(),
            Ok(Err(status)) => format!("STREAM-ERR: {} / {}", status.code(), status.message()),
            Ok(Ok(())) => "stream completed".to_string(),
        };
        // 결과를 안정 파일($HOME)에 기록 — cargo test stdout 미포착 회피.
        let result = format!(
            "chat_state={chat_state}\nset_workspace=loaded:{} {}/{}\ntext={:?}\ntokens={tokens}\nerr={:?}\n",
            sw.loaded, sw.provider, sw.model,
            text.chars().take(80).collect::<String>(), err
        );
        let _ = std::fs::write(format!("{}/rust-grpc-result.txt", std::env::var("HOME").unwrap_or_default()), &result);
        eprintln!("[RUST-GRPC-TEST] {}", result.replace('\n', " | "));
        assert!(err.is_none(), "no error: {:?}", err);
        assert!(tokens > 0, "tokens>0 = 실 z.ai (chat_state={chat_state})");
        assert!(text.chars().count() > 5, "real text");
    }
}
