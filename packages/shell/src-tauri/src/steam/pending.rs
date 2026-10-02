use std::sync::{mpsc, Arc, Mutex};

/// Steam Web API 티켓 요청과 콜백 간의 동기화를 관리하는 제네릭 레지스트리 (#729).
///
/// 티켓 요청 시 SDK 호출과 pending 등록을 단일 뮤텍스 잠금 하에서 원자적으로 처리하여,
/// SDK 호출 즉시 백그라운드 콜백 스레드가 응답을 전달하더라도 pending 등록 전에
/// 응답이 유실되는 경쟁 상태(race condition)를 원천 차단한다.
pub struct TicketRegistry<T: PartialEq + Clone> {
    pending: Arc<Mutex<Vec<(T, mpsc::Sender<Result<Vec<u8>, String>>)>>>,
}

impl<T: PartialEq + Clone> Clone for TicketRegistry<T> {
    fn clone(&self) -> Self {
        Self {
            pending: self.pending.clone(),
        }
    }
}

impl<T: PartialEq + Clone> Default for TicketRegistry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: PartialEq + Clone> TicketRegistry<T> {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 티켓 요청 함수를 잠금 보호 하에서 실행하고, 결과 티켓과 수신 채널을 pending에 등록한다.
    ///
    /// `request_ticket` 클로저가 실행되는 동안 `pending` 뮤텍스가 유지되므로,
    /// SDK 호출 직후 콜백 스레드가 `complete_ticket`을 호출하더라도
    /// 티켓이 등록될 때까지 콜백 처리가 대기한다.
    pub fn request_and_register<F>(
        &self,
        request_ticket: F,
    ) -> (T, mpsc::Receiver<Result<Vec<u8>, String>>)
    where
        F: FnOnce() -> T,
    {
        let (tx, rx) = mpsc::channel();
        let mut list = self.pending.lock().unwrap();
        let ticket = request_ticket();
        list.push((ticket.clone(), tx));
        (ticket, rx)
    }

    /// 콜백 스레드에서 수신한 티켓 핸들과 결과를 매칭하여 대기 중인 채널로 전송한다.
    /// 매칭되는 티켓이 있으면 제거 후 전송하고 true를 반환하며, 없으면 false를 반환한다.
    pub fn complete_ticket(&self, ticket: &T, result: Result<Vec<u8>, String>) -> bool {
        let mut list = self.pending.lock().unwrap();
        if let Some(idx) = list.iter().position(|(t, _)| t == ticket) {
            let (_, tx) = list.swap_remove(idx);
            let _ = tx.send(result);
            true
        } else {
            false
        }
    }

    /// 타임아웃 또는 취소 시 pending 목록에서 해당 티켓을 제거한다.
    pub fn cancel_ticket(&self, ticket: &T) {
        let mut list = self.pending.lock().unwrap();
        if let Some(idx) = list.iter().position(|(t, _)| t == ticket) {
            list.swap_remove(idx);
        }
    }

    /// 현재 등록 대기 중인 티켓 수를 반환한다.
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}
