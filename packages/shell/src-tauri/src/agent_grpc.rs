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
    let mut out = match &ev.event {
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
        Some(Event::Error(e)) => {
            let mut value = json!({"type":"error","requestId":rid,"message":e.message});
            if let Some(raw) = e.code {
                match pb::WireErrorCode::try_from(raw) {
                    Ok(code) if code != pb::WireErrorCode::Unspecified => {
                        value["code"] = json!(code.as_str_name());
                    }
                    _ => {
                        value["message"] = json!("Unsupported wire enum");
                        value["code"] = json!("WIRE_UNSUPPORTED_ENUM");
                    }
                }
            }
            value
        }
        Some(Event::Compacted(c)) => json!({"type":"compacted","requestId":rid,"droppedCount":c.dropped_count}), // UC-compaction(FR-COMPACT)
        Some(Event::PanelToolCall(t)) => json!({"type":"panel_tool_call","requestId":rid,"toolCallId":t.tool_call_id,"toolName":t.tool_name,"args":parse(&t.args_json)}), // UC-PANEL FR-PANEL-2: 환경 도구 위임 → 셸 실행
        Some(Event::Grounding(g)) => {
            match pb::GroundingStatus::try_from(g.status) {
                Ok(status) if status != pb::GroundingStatus::Unspecified => {
                    let sources: Vec<Value> = g.sources.iter()
                        .map(|s| json!({"title":s.title,"sourceUris":s.source_uris}))
                        .collect();
                    json!({
                        "type":"grounding","requestId":rid,
                        "status":status.as_str_name().to_ascii_lowercase(),"sources":sources
                    })
                }
                _ => json!({
                    "type":"error","requestId":rid,"message":"Unsupported wire enum",
                    "code":"WIRE_UNSUPPORTED_ENUM"
                }),
            }
        }
        Some(Event::Artifact(a)) => {
            match a.artifact.as_ref().map(image_artifact_to_ui_value).transpose() {
                Ok(Some(artifact)) => json!({"type":"artifact","requestId":rid,"artifact":artifact}),
                Ok(None) => json!({
                    "type":"error","requestId":rid,"message":"Invalid attachment field artifact",
                    "code":"ATTACHMENT_INVALID_REF"
                }),
                Err(err) => json!({
                    "type":"error","requestId":rid,"message":err.message,
                    "code":err.code
                }),
            }
        }
        Some(Event::ProviderSession(s)) => {
            match pb::ProviderSessionState::try_from(s.state) {
                Ok(state) if state != pb::ProviderSessionState::Unspecified => json!({
                    "type":"provider_session","requestId":rid,"sessionId":s.session_id,
                    "providerSessionRef":s.provider_session_ref,
                    "state":state.as_str_name().to_ascii_lowercase(),
                }),
                _ => json!({
                    "type":"error","requestId":rid,"message":"Unsupported wire enum",
                    "code":"WIRE_UNSUPPORTED_ENUM"
                }),
            }
        }
        Some(Event::ProcessingDisclosure(p)) => {
            let workload = pb::ProcessingWorkload::try_from(p.workload).ok()
                .filter(|value| *value != pb::ProcessingWorkload::Unspecified);
            let destination = pb::ProcessingDestination::try_from(p.destination).ok()
                .filter(|value| *value != pb::ProcessingDestination::Unspecified);
            let decision = pb::ProcessingDecision::try_from(p.decision).ok()
                .filter(|value| *value != pb::ProcessingDecision::Unspecified);
            if workload.is_none() || destination.is_none() || decision.is_none() {
                return json!({
                    "type":"error","requestId":rid,"message":"Unsupported wire enum",
                    "code":"WIRE_UNSUPPORTED_ENUM"
                });
            }
            let mut value = json!({
                "type":"processing_disclosure",
                "requestId":rid,
                "workload":workload.unwrap().as_str_name().to_ascii_lowercase(),
                "destination":destination.unwrap().as_str_name().to_ascii_lowercase(),
                "decision":decision.unwrap().as_str_name().to_ascii_lowercase(),
                "processingProfileRef":p.processing_profile_ref,
            });
            if let Some(provider) = &p.provider { value["provider"] = json!(provider); }
            if let Some(model) = &p.model { value["model"] = json!(model); }
            value
        }
        None => json!({"type":"error","requestId":rid,"message":"empty AgentEvent"}),
    };
    if let Some(activity_id) = &ev.activity_id {
        out["activityId"] = json!(activity_id);
    }
    if let Some(profile_generation) = ev.profile_generation {
        out["profileGeneration"] = json!(profile_generation);
    }
    out
}

/// 셸이 만든 wire JSON({type:"chat_request",requestId,messages,...}) → proto ChatRequest. provider 제거(정본).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireInputError {
    pub code: &'static str,
    pub message: String,
}

impl WireInputError {
    fn unsupported_enum(field: &str, value: Option<&str>) -> Self {
        let value = value.unwrap_or("<missing>");
        Self {
            code: "WIRE_UNSUPPORTED_ENUM",
            message: format!("Unsupported wire enum {field}={value}"),
        }
    }

    fn attachment(code: &'static str, field: &str) -> Self {
        Self {
            code,
            message: format!("Invalid attachment field {field}"),
        }
    }
}

const MAX_ATTACHMENT_SIZE_BYTES: i64 = 20 * 1024 * 1024;

fn validate_image_attachment_fields(
    id: &str,
    kind: &str,
    mime_type: &str,
    size_bytes: i64,
    local_ref: &str,
) -> Result<(), WireInputError> {
    if !is_opaque_attachment_ref(id) {
        return Err(WireInputError::attachment("ATTACHMENT_INVALID_REF", "id"));
    }
    if !is_opaque_attachment_ref(local_ref) {
        return Err(WireInputError::attachment("ATTACHMENT_INVALID_REF", "localRef"));
    }
    if kind != "image" {
        return Err(WireInputError::attachment("ATTACHMENT_UNSUPPORTED_TYPE", "kind"));
    }
    if !matches!(mime_type, "image/png" | "image/jpeg" | "image/webp") {
        return Err(WireInputError::attachment("ATTACHMENT_UNSUPPORTED_TYPE", "mimeType"));
    }
    if size_bytes <= 0 {
        return Err(WireInputError::attachment("ATTACHMENT_INVALID_REF", "sizeBytes"));
    }
    if size_bytes > MAX_ATTACHMENT_SIZE_BYTES {
        return Err(WireInputError::attachment("ATTACHMENT_TOO_LARGE", "sizeBytes"));
    }
    Ok(())
}

fn image_artifact_to_ui_value(x: &pb::ImageArtifact) -> Result<Value, WireInputError> {
    validate_image_attachment_fields(&x.id, &x.kind, &x.mime_type, x.size_bytes, &x.local_ref)?;
    let mut value = json!({
        "id":x.id, "kind":x.kind, "mimeType":x.mime_type,
        "sizeBytes":x.size_bytes, "localRef":x.local_ref,
    });
    if let Some(name) = &x.name { value["name"] = json!(name); }
    Ok(value)
}

fn is_opaque_attachment_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value
            .chars()
            .any(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn parse_attachment_ref(value: &Value) -> Result<pb::AttachmentRef, WireInputError> {
    let Some(item) = value.as_object() else {
        return Err(WireInputError::attachment("ATTACHMENT_INVALID_REF", "attachment"));
    };
    let string_field = |field: &str| item.get(field).and_then(|x| x.as_str());
    let id = string_field("id")
        .ok_or_else(|| WireInputError::attachment("ATTACHMENT_INVALID_REF", "id"))?;
    let local_ref = string_field("localRef")
        .ok_or_else(|| WireInputError::attachment("ATTACHMENT_INVALID_REF", "localRef"))?;
    let kind = string_field("kind")
        .ok_or_else(|| WireInputError::attachment("ATTACHMENT_UNSUPPORTED_TYPE", "kind"))?;
    let mime_type = string_field("mimeType")
        .ok_or_else(|| WireInputError::attachment("ATTACHMENT_UNSUPPORTED_TYPE", "mimeType"))?;
    let size_bytes = item
        .get("sizeBytes")
        .and_then(|x| x.as_i64())
        .ok_or_else(|| WireInputError::attachment("ATTACHMENT_INVALID_REF", "sizeBytes"))?;
    validate_image_attachment_fields(id, kind, mime_type, size_bytes, local_ref)?;
    Ok(pb::AttachmentRef {
        id: id.to_string(),
        kind: kind.to_string(),
        mime_type: mime_type.to_string(),
        size_bytes,
        local_ref: local_ref.to_string(),
    })
}

pub fn json_to_chat_request(v: &Value) -> ChatRequest {
    try_json_to_chat_request(v).expect("valid chat_request wire JSON")
}

pub fn try_json_to_chat_request(v: &Value) -> Result<ChatRequest, WireInputError> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let messages = v
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| {
                    let attachments = match m.get("attachments") {
                        Some(items) => {
                            let items = items.as_array().ok_or_else(|| {
                                WireInputError::attachment("ATTACHMENT_INVALID_REF", "attachments")
                            })?;
                            items
                                .iter()
                                .map(parse_attachment_ref)
                                .collect::<Result<Vec<_>, _>>()?
                        }
                        None => Vec::new(),
					};
					Ok(Message {
						role: m
							.get("role")
							.and_then(|x| x.as_str())
							.unwrap_or("user")
							.to_string(),
						content: m
							.get("content")
							.and_then(|x| x.as_str())
							.unwrap_or("")
							.to_string(),
						tool_call_id: m
							.get("toolCallId")
							.and_then(|x| x.as_str())
							.map(|x| x.to_string()),
						attachments,
					})
				})
                .collect::<Result<Vec<_>, WireInputError>>()
        })
        .transpose()?
        .unwrap_or_default();

    let channel = match v.get("channel") {
        Some(c) => match c.get("kind").and_then(|x| x.as_str()) {
            Some("shell") => Some(pb::ChannelContext {
                channel: Some(pb::channel_context::Channel::Shell(pb::ShellChannel {})),
            }),
            Some("discord") => Some(pb::ChannelContext {
                channel: Some(pb::channel_context::Channel::Discord(pb::DiscordChannel {
                    binding_id: c.get("bindingId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    guild_id: c.get("guildId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    channel_id: c.get("channelId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    user_id: c.get("userId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                })),
            }),
            other => return Err(WireInputError::unsupported_enum("channel.kind", other)),
        },
        None => None,
    };

    let grounding = match v.get("grounding") {
        Some(g) => {
            let policy = match g.get("policy").and_then(|x| x.as_str()) {
                Some("off") => pb::GroundingPolicy::Off as i32,
                Some("available") => pb::GroundingPolicy::Available as i32,
                Some("required") => pb::GroundingPolicy::Required as i32,
                other => return Err(WireInputError::unsupported_enum("grounding.policy", other)),
            };
            Some(pb::GroundingRequest {
                policy,
                knowledge_scope: g.get("knowledgeScope").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            })
        }
        None => None,
    };

    let provider_session = match v.get("providerSession") {
        Some(p) => {
            let mode = match p.get("mode").and_then(|x| x.as_str()) {
                Some("new") => pb::ProviderSessionMode::New as i32,
                Some("resume") => pb::ProviderSessionMode::Resume as i32,
                other => return Err(WireInputError::unsupported_enum("providerSession.mode", other)),
            };
            Some(pb::ProviderSessionRequest {
                mode,
                provider_session_ref: p.get("providerSessionRef").and_then(|x| x.as_str()).map(str::to_string),
            })
        }
        None => None,
    };

    Ok(ChatRequest {
        request_id: s("requestId").unwrap_or_default(),
        session_id: s("sessionId"),
        messages,
        system_prompt: s("systemPrompt"),
        // S4 — 셸이 보낸 구조화 environmentSegments(array) → proto JSON 문자열(args_json 동형, 무손실).
        // 코어가 화이트리스트 디코드(avatarEmotion|panel). 부재/비배열 = None(필드 omit, 무회귀).
        environment_segments_json: v
            .get("environmentSegments")
            .filter(|x| x.is_array())
            .map(|x| x.to_string()),
        enable_tools: v.get("enableTools").and_then(|x| x.as_bool()),
        enable_thinking: v.get("enableThinking").and_then(|x| x.as_bool()),
        gateway_url: s("gatewayUrl"),
        disabled_skills: v
            .get("disabledSkills")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|x| x.to_string())).collect())
            .unwrap_or_default(),
        activity_resume: v.get("activityResume").and_then(|r| {
            Some(pb::ActivityResume {
                activity_id: r.get("activityId")?.as_str()?.to_string(),
                profile_generation: r.get("profileGeneration")?.as_i64()?,
                yield_generation: r.get("yieldGeneration")?.as_i64()?,
                resume_token: r.get("resumeToken")?.as_str()?.to_string(),
            })
        }),
        channel,
        grounding,
        provider_session,
        processing: v.get("processing").map(|p| pb::ProcessingRequest {
            processing_profile_ref: p.get("processingProfileRef")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        }),
        // Keep clean-runner builds source-compatible when naia-agent grows
        // another optional transport field before the shell wires it.
        ..Default::default()
    })
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

    pub async fn cancel(&mut self, request_id: String, activity_id: Option<String>) -> Result<(), tonic::Status> {
        self.client
            .cancel(CancelRequest {
                request_id,
                activity_id,
                ..Default::default()
            })
            .await?;
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

    pub async fn panel_tool_result(&mut self, request_id: String, tool_call_id: String, output: String, success: bool, activity_id: Option<String>) -> Result<(), tonic::Status> {
        self.client
            .panel_tool_result(pb::PanelToolResultMsg {
                request_id,
                tool_call_id,
                output,
                success,
                activity_id,
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    pub async fn configure_speech_profile(&mut self, req: pb::ConfigureSpeechProfileRequest) -> Result<bool, tonic::Status> {
        Ok(self.client.configure_speech_profile(req).await?.into_inner().ok)
    }

    pub async fn subscribe_speech_activities<F: FnMut(String)>(&mut self, session_id: String, mut emit: F) -> Result<(), tonic::Status> {
        let mut stream = self.client
            .subscribe_speech_activities(pb::SpeechActivitySubscription { session_id })
            .await?
            .into_inner();
        while let Some(ev) = stream.message().await? {
            emit(agent_event_to_ui_json(&ev).to_string());
        }
        Ok(())
    }

    pub async fn yield_speech_activity(&mut self, session_id: String, activity_id: String) -> Result<pb::YieldSpeechActivityResult, tonic::Status> {
        Ok(self.client
            .yield_speech_activity(pb::YieldSpeechActivityRequest { session_id, activity_id })
            .await?
            .into_inner())
    }

    pub async fn stop_speech_activity(&mut self, session_id: String, activity_id: Option<String>) -> Result<bool, tonic::Status> {
        Ok(self.client
            .stop_speech_activity(pb::StopSpeechActivityRequest { session_id, activity_id })
            .await?
            .into_inner()
            .ok)
    }

    pub async fn control_speech_activity(&mut self, session_id: String, activity_id: Option<String>, action: String) -> Result<bool, tonic::Status> {
        Ok(self.client
            .control_speech_activity(pb::ControlSpeechActivityRequest { session_id, activity_id, action })
            .await?
            .into_inner()
            .ok)
    }
}

// S4 — json_to_chat_request 의 environment_segments_json 직렬화 단위 테스트(결정론, gRPC 불요).
#[cfg(test)]
mod transcode_tests {
    use super::*;

    #[test]
    fn wire_v1_json_to_proto_preserves_nested_input() {
        let v = serde_json::json!({
            "requestId": "wire-r1",
            "sessionId": "local-session-1",
            "messages": [{
                "role": "user",
                "content": "이 화면을 설명해줘",
                "attachments": [{
                    "id": "att_01",
                    "kind": "image",
                    "mimeType": "image/png",
                    "sizeBytes": 1024,
                    "localRef": "img_01"
                }]
            }],
            "channel": { "kind": "shell" },
            "grounding": {
                "policy": "available",
                "knowledgeScope": "workshop"
            },
            "providerSession": { "mode": "new" }
            ,"processing": {
                "processingProfileRef": "profile-local-cloud-001",
                "actualDestination": "local_device"
            }
        });

        let req = json_to_chat_request(&v);
        assert_eq!(req.messages[0].attachments.len(), 1);
        assert_eq!(req.messages[0].attachments[0].local_ref, "img_01");
        assert!(req.channel.is_some());
        assert!(req.grounding.is_some());
        assert!(req.provider_session.is_some());
        assert_eq!(
            req.processing.as_ref().unwrap().processing_profile_ref,
            "profile-local-cloud-001"
        );
        assert_eq!(req.grounding.as_ref().unwrap().knowledge_scope, "workshop");
        assert_eq!(req.provider_session.as_ref().unwrap().mode, pb::ProviderSessionMode::New as i32);
    }

    #[test]
    fn wire_v1_proto_events_preserve_structured_output_and_error_code() {
        let grounding = pb::AgentEvent {
            request_id: "wire-r1".into(),
            event: Some(Event::Grounding(pb::GroundingEvent {
                status: pb::GroundingStatus::Grounded as i32,
                sources: vec![pb::GroundingSource {
                    title: "수업 안내".into(),
                    source_uris: vec!["kb://workshop".into()],
                }],
            })),
            ..Default::default()
        };
        let grounding_json = agent_event_to_ui_json(&grounding);
        assert_eq!(grounding_json["type"], "grounding");
        assert_eq!(grounding_json["status"], "grounded");
        assert_eq!(grounding_json["sources"][0]["sourceUris"][0], "kb://workshop");

        let artifact = pb::AgentEvent {
            request_id: "wire-r1".into(),
            event: Some(Event::Artifact(pb::ArtifactEvent {
                artifact: Some(pb::ImageArtifact {
                    id: "out_01".into(),
                    kind: "image".into(),
                    mime_type: "image/png".into(),
                    size_bytes: 2048,
                    local_ref: "img_out_01".into(),
                    name: Some("preview.png".into()),
                }),
            })),
            ..Default::default()
        };
        let artifact_json = agent_event_to_ui_json(&artifact);
        assert_eq!(artifact_json["type"], "artifact");
        assert_eq!(artifact_json["artifact"]["localRef"], "img_out_01");

        let error = pb::AgentEvent {
            request_id: "wire-r1".into(),
            event: Some(Event::Error(pb::ErrorEvent {
                message: "invalid request".into(),
                code: Some(pb::WireErrorCode::AttachmentInvalidRef as i32),
            })),
            ..Default::default()
        };
        let error_json = agent_event_to_ui_json(&error);
        assert_eq!(error_json["type"], "error");
        assert_eq!(error_json["code"], "ATTACHMENT_INVALID_REF");

        let provider_session = pb::AgentEvent {
            request_id: "wire-r1".into(),
            event: Some(Event::ProviderSession(pb::ProviderSessionEvent {
                session_id: "local-session-1".into(),
                provider_session_ref: "opaque-session-ref".into(),
                state: pb::ProviderSessionState::Started as i32,
            })),
            ..Default::default()
        };
        let session_json = agent_event_to_ui_json(&provider_session);
        assert_eq!(session_json["type"], "provider_session");
        assert_eq!(session_json["sessionId"], "local-session-1");
        assert_eq!(session_json["providerSessionRef"], "opaque-session-ref");
        assert_eq!(session_json["state"], "started");

        let processing = pb::AgentEvent {
            request_id: "wire-r1".into(),
            event: Some(Event::ProcessingDisclosure(pb::ProcessingDisclosureEvent {
                workload: pb::ProcessingWorkload::Embedding as i32,
                destination: pb::ProcessingDestination::ExternalCloud as i32,
                decision: pb::ProcessingDecision::Allowed as i32,
                processing_profile_ref: "profile-local-cloud-001".into(),
                provider: Some("openai".into()),
                model: Some("text-embedding-3-small".into()),
            })),
            ..Default::default()
        };
        let processing_json = agent_event_to_ui_json(&processing);
        assert_eq!(processing_json["type"], "processing_disclosure");
        assert_eq!(processing_json["workload"], "embedding");
        assert_eq!(processing_json["destination"], "external_cloud");
        assert_eq!(processing_json["decision"], "allowed");
        assert_eq!(
            processing_json["processingProfileRef"],
            "profile-local-cloud-001"
        );
    }

    #[test]
    fn wire_v1_discord_and_resume_context_are_not_flattened_or_renamed() {
        let req = json_to_chat_request(&serde_json::json!({
            "requestId": "wire-r2",
            "sessionId": "local-session-2",
            "messages": [{ "role": "user", "content": "질문" }],
            "channel": {
                "kind": "discord", "bindingId": "bind_1", "guildId": "1234567890123456",
                "channelId": "2234567890123456", "userId": "3234567890123456"
            },
            "grounding": { "policy": "required", "knowledgeScope": "workshop" },
            "providerSession": { "mode": "resume", "providerSessionRef": "opaque-session-ref" }
        }));
        let discord = match req.channel.unwrap().channel.unwrap() {
            pb::channel_context::Channel::Discord(value) => value,
            _ => panic!("discord channel expected"),
        };
        assert_eq!(discord.binding_id, "bind_1");
        assert_eq!(discord.guild_id, "1234567890123456");
        assert_eq!(req.grounding.unwrap().policy, pb::GroundingPolicy::Required as i32);
        let session = req.provider_session.unwrap();
        assert_eq!(session.mode, pb::ProviderSessionMode::Resume as i32);
        assert_eq!(session.provider_session_ref.as_deref(), Some("opaque-session-ref"));
    }

    #[test]
    fn wire_v1_unknown_input_enums_fail_closed_before_proto_request() {
        for (payload, field) in [
            (
                serde_json::json!({
                    "requestId": "wire-invalid-channel",
                    "messages": [],
                    "channel": { "kind": "matrix" }
                }),
                "channel.kind",
            ),
            (
                serde_json::json!({
                    "requestId": "wire-invalid-grounding",
                    "messages": [],
                    "grounding": { "policy": "always", "knowledgeScope": "workshop" }
                }),
                "grounding.policy",
            ),
            (
                serde_json::json!({
                    "requestId": "wire-invalid-provider-session",
                    "messages": [],
                    "providerSession": { "mode": "attach" }
                }),
                "providerSession.mode",
            ),
        ] {
            let err = try_json_to_chat_request(&payload).expect_err("invalid enum rejected");
            assert_eq!(err.code, "WIRE_UNSUPPORTED_ENUM");
            assert!(err.message.contains(field));
        }
    }

    #[test]
    fn wire_v1_invalid_attachments_fail_closed_before_proto_request() {
        for (attachment, code, field) in [
            (
                serde_json::json!({
                    "id": "a1", "kind": "audio", "mimeType": "audio/wav",
                    "sizeBytes": 10, "localRef": "img_1"
                }),
                "ATTACHMENT_UNSUPPORTED_TYPE",
                "kind",
            ),
            (
                serde_json::json!({
                    "id": "a1", "kind": "image", "mimeType": "image/gif",
                    "sizeBytes": 10, "localRef": "img_1"
                }),
                "ATTACHMENT_UNSUPPORTED_TYPE",
                "mimeType",
            ),
            (
                serde_json::json!({
                    "id": "a1", "kind": "image", "mimeType": "image/png",
                    "sizeBytes": 20 * 1024 * 1024 + 1, "localRef": "img_1"
                }),
                "ATTACHMENT_TOO_LARGE",
                "sizeBytes",
            ),
            (
                serde_json::json!({
                    "id": "a1", "kind": "image", "mimeType": "image/png",
                    "sizeBytes": 10, "localRef": "file:///tmp/raw.png"
                }),
                "ATTACHMENT_INVALID_REF",
                "localRef",
            ),
            (
                serde_json::json!({
                    "id": "a1", "kind": "image", "mimeType": "image/png",
                    "sizeBytes": 10, "localRef": ".."
                }),
                "ATTACHMENT_INVALID_REF",
                "localRef",
            ),
            (
                serde_json::json!({
                    "id": ".", "kind": "image", "mimeType": "image/png",
                    "sizeBytes": 10, "localRef": "img_1"
                }),
                "ATTACHMENT_INVALID_REF",
                "id",
            ),
        ] {
            let payload = serde_json::json!({
                "requestId": "wire-invalid-attachment",
                "messages": [{
                    "role": "user", "content": "image", "attachments": [attachment]
                }]
            });
            let err = try_json_to_chat_request(&payload).expect_err("invalid attachment rejected");
            assert_eq!(err.code, code);
            assert!(err.message.contains(field));
        }
    }

    #[test]
    fn wire_v1_invalid_output_artifacts_fail_closed_before_webview_emit() {
        for (artifact, code, field) in [
            (
                pb::ImageArtifact {
                    id: "out_01".into(),
                    kind: "audio".into(),
                    mime_type: "audio/wav".into(),
                    size_bytes: 10,
                    local_ref: "img_out_01".into(),
                    name: None,
                },
                "ATTACHMENT_UNSUPPORTED_TYPE",
                "kind",
            ),
            (
                pb::ImageArtifact {
                    id: "out_01".into(),
                    kind: "image".into(),
                    mime_type: "image/gif".into(),
                    size_bytes: 10,
                    local_ref: "img_out_01".into(),
                    name: None,
                },
                "ATTACHMENT_UNSUPPORTED_TYPE",
                "mimeType",
            ),
            (
                pb::ImageArtifact {
                    id: "out_01".into(),
                    kind: "image".into(),
                    mime_type: "image/png".into(),
                    size_bytes: 20 * 1024 * 1024 + 1,
                    local_ref: "img_out_01".into(),
                    name: None,
                },
                "ATTACHMENT_TOO_LARGE",
                "sizeBytes",
            ),
            (
                pb::ImageArtifact {
                    id: "out_01".into(),
                    kind: "image".into(),
                    mime_type: "image/png".into(),
                    size_bytes: 10,
                    local_ref: "file:///tmp/raw.png".into(),
                    name: None,
                },
                "ATTACHMENT_INVALID_REF",
                "localRef",
            ),
            (
                pb::ImageArtifact {
                    id: ".".into(),
                    kind: "image".into(),
                    mime_type: "image/png".into(),
                    size_bytes: 10,
                    local_ref: "img_out_01".into(),
                    name: None,
                },
                "ATTACHMENT_INVALID_REF",
                "id",
            ),
        ] {
            let value = agent_event_to_ui_json(&pb::AgentEvent {
                request_id: "wire-invalid-artifact".into(),
                event: Some(Event::Artifact(pb::ArtifactEvent {
                    artifact: Some(artifact),
                })),
                ..Default::default()
            });
            assert_eq!(value["type"], "error");
            assert_eq!(value["code"], code);
            assert!(value["message"].as_str().unwrap_or("").contains(field));
            assert!(value.get("artifact").is_none());
        }

        let missing = agent_event_to_ui_json(&pb::AgentEvent {
            request_id: "wire-missing-artifact".into(),
            event: Some(Event::Artifact(pb::ArtifactEvent { artifact: None })),
            ..Default::default()
        });
        assert_eq!(missing["type"], "error");
        assert_eq!(missing["code"], "ATTACHMENT_INVALID_REF");
        assert!(missing.get("artifact").is_none());
    }

    #[test]
    fn wire_v1_unspecified_and_unknown_output_enums_fail_closed() {
        for event in [
            Event::Grounding(pb::GroundingEvent { status: 0, sources: vec![] }),
            Event::Grounding(pb::GroundingEvent { status: 999, sources: vec![] }),
            Event::ProviderSession(pb::ProviderSessionEvent {
                session_id: "s1".into(), provider_session_ref: "ref".into(), state: 0,
            }),
            Event::ProviderSession(pb::ProviderSessionEvent {
                session_id: "s1".into(), provider_session_ref: "ref".into(), state: 999,
            }),
            Event::Error(pb::ErrorEvent {
                message: "unsafe detail".into(), code: Some(0),
            }),
            Event::Error(pb::ErrorEvent {
                message: "unsafe detail".into(), code: Some(999),
            }),
            Event::ProcessingDisclosure(pb::ProcessingDisclosureEvent {
                workload: 0, destination: pb::ProcessingDestination::LocalDevice as i32,
                decision: pb::ProcessingDecision::Allowed as i32,
                processing_profile_ref: "profile".into(), provider: None, model: None,
            }),
            Event::ProcessingDisclosure(pb::ProcessingDisclosureEvent {
                workload: pb::ProcessingWorkload::Embedding as i32, destination: 999,
                decision: pb::ProcessingDecision::Allowed as i32,
                processing_profile_ref: "profile".into(), provider: None, model: None,
            }),
            Event::ProcessingDisclosure(pb::ProcessingDisclosureEvent {
                workload: pb::ProcessingWorkload::Embedding as i32,
                destination: pb::ProcessingDestination::ExternalCloud as i32, decision: 0,
                processing_profile_ref: "profile".into(), provider: None, model: None,
            }),
        ] {
            let value = agent_event_to_ui_json(&pb::AgentEvent {
                request_id: "wire-invalid".into(), event: Some(event), ..Default::default()
            });
            assert_eq!(value["type"], "error");
            assert_eq!(value["code"], "WIRE_UNSUPPORTED_ENUM");
            assert_ne!(value["message"], "unsafe detail");
        }
    }

    #[test]
    fn environment_segments_array_serialized_to_json_string() {
        let v = serde_json::json!({
            "requestId": "r1",
            "messages": [{ "role": "user", "content": "hi" }],
            "environmentSegments": [
                { "kind": "avatarEmotion" },
                { "kind": "app", "entries": [{ "type": "bgm", "data": { "track": "lofi" } }] }
            ]
        });
        let req = json_to_chat_request(&v);
        let json = req.environment_segments_json.expect("environment_segments_json present");
        // 코어가 다시 파싱해 화이트리스트 디코드 — 무손실 array 운반.
        let parsed: Value = serde_json::from_str(&json).expect("valid json");
        assert!(parsed.is_array());
        assert_eq!(parsed[0]["kind"], "avatarEmotion");
        assert_eq!(parsed[1]["kind"], "app");
        assert_eq!(parsed[1]["entries"][0]["type"], "bgm");
        // systemPrompt 미전송(두벌 제거) → None.
        assert!(req.system_prompt.is_none());
    }

    #[test]
    fn missing_environment_segments_is_none() {
        let v = serde_json::json!({ "requestId": "r1", "messages": [] });
        assert!(json_to_chat_request(&v).environment_segments_json.is_none());
    }

    #[test]
    fn non_array_environment_segments_is_none() {
        let v = serde_json::json!({ "requestId": "r1", "messages": [], "environmentSegments": "nope" });
        assert!(json_to_chat_request(&v).environment_segments_json.is_none());
    }

    #[test]
    fn explicit_system_prompt_override_preserved() {
        // voice-pipeline / discord 의 명시 override 경로(코어가 honor) — 무회귀.
        let v = serde_json::json!({ "requestId": "r1", "messages": [], "systemPrompt": "OVERRIDE" });
        assert_eq!(json_to_chat_request(&v).system_prompt.as_deref(), Some("OVERRIDE"));
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
