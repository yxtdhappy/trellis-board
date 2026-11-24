//! 心跳节奏与超时策略。
//!
//! 背景：服务端重启后曾出现心跳循环永久停在绑定同步 await 上的故障（详见
//! `.trellis/tasks/11-24-heartbeat-loop-resilience`）。这里把节奏、超时与
//! 结果分类抽成纯逻辑，保证三件事：
//!
//! 1. 心跳不被同步阻塞（同步调用方必须用 [`bounded`] 包一层）；
//! 2. 单轮心跳有总上限，超时后仍会进入下一轮；
//! 3. 只有认证失败才会让调用方停止循环。

use std::future::Future;
use std::time::Duration;

use crate::agent::protocol::{self, AgentError};

/// 正常心跳间隔。
pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// 失败后的首次重试等待，同时是退避的起点。
pub(crate) const RETRY_BASE: Duration = Duration::from_secs(1);
/// 失败退避上限，同时也是服务端判定离线的阈值量级（60s）。
pub(crate) const RETRY_MAX: Duration = Duration::from_secs(60);

/// 心跳节奏与超时策略。生产用 [`Default`]，测试可只覆盖单个字段提速。
#[derive(Clone, Copy, Debug)]
pub(crate) struct HeartbeatPolicy {
    /// 正常心跳间隔。
    pub interval: Duration,
    /// 失败后的首次重试等待。
    pub retry_base: Duration,
    /// 失败退避上限。
    pub retry_max: Duration,
    /// 心跳路径上一次绑定同步的等待上限。
    pub binding_sync_timeout: Duration,
    /// 单轮心跳（含同步）的总上限。
    pub round_timeout: Duration,
}

impl Default for HeartbeatPolicy {
    fn default() -> Self {
        Self {
            interval: HEARTBEAT_INTERVAL,
            retry_base: RETRY_BASE,
            retry_max: RETRY_MAX,
            binding_sync_timeout: Duration::from_secs(30),
            round_timeout: Duration::from_secs(60),
        }
    }
}

/// 一轮心跳的返回值：外层是「是否超时」，内层是心跳本身的结果。
pub(crate) type RoundResult =
    Result<Result<(), AgentError>, tokio::time::error::Elapsed>;

/// 一轮心跳的归一化结果，便于分支处理与单测。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RoundOutcome {
    Success,
    /// 认证失败：唯一允许停止运行时的结果。
    AuthenticationFailure,
    Failure,
    /// 整轮超过 `round_timeout`，future 已被丢弃。
    TimedOut,
}

impl RoundOutcome {
    pub(crate) fn classify(round: &RoundResult) -> Self {
        match round {
            Ok(Ok(())) => Self::Success,
            Ok(Err(error)) if protocol::is_authentication_error(error) => {
                Self::AuthenticationFailure
            }
            Ok(Err(_)) => Self::Failure,
            Err(_) => Self::TimedOut,
        }
    }

    /// 返回 `(下一轮失败等待, 距离下一轮的间隔)`。
    ///
    /// `current_delay` 是本轮失败前已经睡过的退避时长；`Failure` 分支沿用
    /// 「先睡本次退避、再翻倍」的既有节奏，因此只调整下一次的退避值。
    pub(crate) fn next_delays(
        self,
        current_delay: Duration,
        policy: &HeartbeatPolicy,
    ) -> (Duration, Duration) {
        match self {
            Self::Success | Self::TimedOut => (policy.retry_base, policy.interval),
            Self::Failure => ((current_delay * 2).min(policy.retry_max), Duration::ZERO),
            // 认证失败由调用方 `break`，这里只保持原值以免掩盖意图。
            Self::AuthenticationFailure => (current_delay, Duration::ZERO),
        }
    }
}

/// 给任意 future 加上限；超时只记一条日志并返回 `false`。
///
/// 心跳路径上的绑定同步必须经过这里：既保证在线状态不被同步拖住，也让
/// future 被丢弃后各锁随 drop 释放（下一轮重新对账）。
pub(crate) async fn bounded<F>(limit: Duration, label: &str, future: F) -> bool
where
    F: Future<Output = ()>,
{
    if tokio::time::timeout(limit, future).await.is_ok() {
        return true;
    }
    crate::logging::warn(&format!(
        "{label}超过 {} 秒未完成，已跳过本轮",
        limit.as_secs()
    ));
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::protocol::code;

    fn policy() -> HeartbeatPolicy {
        HeartbeatPolicy::default()
    }

    #[tokio::test]
    async fn classify_separates_auth_failure_from_transient_errors() {
        assert_eq!(
            RoundOutcome::classify(&Ok(Ok(()))),
            RoundOutcome::Success
        );
        assert_eq!(
            RoundOutcome::classify(&Ok(Err(AgentError::new(code::AUTH_REVOKED, "revoked")))),
            RoundOutcome::AuthenticationFailure
        );
        assert_eq!(
            RoundOutcome::classify(&Ok(Err(AgentError::new(code::NETWORK_ERROR, "offline")))),
            RoundOutcome::Failure
        );

        let timed_out: RoundResult =
            tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>())
                .await
                .map(|_| Ok(()));
        assert_eq!(RoundOutcome::classify(&timed_out), RoundOutcome::TimedOut);
    }

    #[tokio::test]
    async fn timeout_still_schedules_the_next_heartbeat() {
        // 超时不能退出循环：下一轮仍按正常间隔发起。
        let (delay, next_delay) = RoundOutcome::TimedOut.next_delays(Duration::from_secs(60), &policy());
        assert_eq!(delay, Duration::from_secs(1));
        assert_eq!(next_delay, Duration::from_secs(15));
    }

    #[tokio::test]
    async fn failure_backoff_doubles_and_caps() {
        let (delay, next_delay) = RoundOutcome::Failure.next_delays(Duration::from_secs(1), &policy());
        assert_eq!(delay, Duration::from_secs(2));
        assert_eq!(next_delay, Duration::ZERO);

        let (capped, _) = RoundOutcome::Failure.next_delays(Duration::from_secs(45), &policy());
        assert_eq!(capped, Duration::from_secs(60));
    }

    #[tokio::test]
    async fn success_resets_backoff_to_base() {
        let (delay, next_delay) = RoundOutcome::Success.next_delays(Duration::from_secs(60), &policy());
        assert_eq!(delay, Duration::from_secs(1));
        assert_eq!(next_delay, Duration::from_secs(15));
    }

    #[tokio::test]
    async fn bounded_gives_up_after_the_limit() {
        let started = std::time::Instant::now();
        let completed = bounded(Duration::from_millis(50), "测试同步", async {
            tokio::time::sleep(Duration::from_secs(10)).await;
        })
        .await;
        assert!(!completed);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn bounded_lets_fast_work_finish() {
        assert!(bounded(Duration::from_secs(1), "测试同步", async {}).await);
    }
}
