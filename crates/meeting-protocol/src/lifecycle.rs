//! Server-side meeting lifecycle. Every state change goes through
//! [`MeetingState::transition`], so an illegal jump (for example delivering a
//! meeting whose audio was never finalized) is a bug caught here rather than
//! a corrupted row.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum MeetingState {
    /// Created; chunks may be uploaded.
    Recording,
    /// Finalize received and every chunk present; waiting for the worker.
    Finalized,
    Transcribing,
    Summarizing,
    Delivering,
    Delivered,
    /// A step failed permanently; `failure` says why. Audio is kept.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Finalize,
    StartTranscription,
    StartSummary,
    StartDelivery,
    Delivered,
    Fail,
    /// A recording that never received audio is closed: an explicit cancel
    /// before capture began, or the aged-empty sweep. Never with chunks.
    Abandon,
    /// Operator retry of a failed meeting: back to the start of processing.
    Retry,
}

impl MeetingState {
    pub fn as_str(self) -> &'static str {
        match self {
            MeetingState::Recording => "recording",
            MeetingState::Finalized => "finalized",
            MeetingState::Transcribing => "transcribing",
            MeetingState::Summarizing => "summarizing",
            MeetingState::Delivering => "delivering",
            MeetingState::Delivered => "delivered",
            MeetingState::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
    }

    pub fn accepts_chunks(self) -> bool {
        self == MeetingState::Recording
    }

    pub fn transition(self, t: Transition) -> Option<MeetingState> {
        use MeetingState::*;
        use Transition as T;
        Some(match (self, t) {
            (Recording, T::Finalize) => Finalized,
            // A worker that crashed mid-step resumes from the same step.
            (Finalized | Transcribing, T::StartTranscription) => Transcribing,
            (Transcribing | Summarizing, T::StartSummary) => Summarizing,
            (Summarizing | Delivering, T::StartDelivery) => Delivering,
            (Delivering, T::Delivered) => Delivered,
            (Finalized | Transcribing | Summarizing | Delivering, T::Fail) => Failed,
            (Recording, T::Abandon) => Failed,
            (Failed, T::Retry) => Finalized,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MeetingState::*, Transition::*, *};

    #[test]
    fn happy_path() {
        let mut s = Recording;
        for t in [
            Finalize,
            StartTranscription,
            StartSummary,
            StartDelivery,
            Transition::Delivered,
        ] {
            s = s.transition(t).unwrap();
        }
        assert_eq!(s, MeetingState::Delivered);
    }

    #[test]
    fn illegal_jumps_are_refused() {
        assert_eq!(Recording.transition(StartDelivery), None);
        assert_eq!(Recording.transition(Fail), None);
        assert_eq!(Recording.transition(Abandon), Some(Failed));
        assert_eq!(Finalized.transition(Abandon), None);
        assert_eq!(Failed.transition(Abandon), None);
        assert_eq!(MeetingState::Delivered.transition(Finalize), None);
        assert_eq!(MeetingState::Delivered.transition(Fail), None);
        assert_eq!(Finalized.transition(Finalize), None);
        assert_eq!(Transcribing.transition(StartDelivery), None);
    }

    #[test]
    fn crashed_steps_resume_and_failures_retry() {
        assert_eq!(
            Transcribing.transition(StartTranscription),
            Some(Transcribing)
        );
        assert_eq!(Delivering.transition(StartDelivery), Some(Delivering));
        assert_eq!(Failed.transition(Retry), Some(Finalized));
        assert_eq!(MeetingState::parse("delivering"), Some(Delivering));
        assert_eq!(Delivering.as_str(), "delivering");
    }
}
