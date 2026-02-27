//! DASH (Dynamic Adaptive Streaming over HTTP) Protocol Handler
//!
//! Parses MPD manifests to extract available quality variants
//! and segment URLs for download.
//!
//! Status: Stub implementation — foundational types and trait impl
//! are in place. Full MPD XML parsing will be added when needed.
//!
//! DASH is more complex than HLS because:
//! - MPD is XML (not plaintext like m3u8)
//! - Segment URLs can be templated (SegmentTemplate)
//! - Multiple AdaptationSets (video, audio, subtitle)
//! - Initialization segments and media segments are separate
//!
//! This stub returns an error indicating DASH is not yet supported,
//! keeping the architecture clean for future implementation.

use crate::error::DlmanError;
use crate::media::ProtocolHandler;
use dlman_types::{MediaProtocol, MediaVariant};

/// Handler for DASH (MPD) streams.
///
/// Currently a stub. The trait implementation exists so that
/// `MediaResolver` can dispatch to it, but actual MPD parsing
/// is not yet implemented.
pub struct DashHandler {
    #[allow(dead_code)]
    client: reqwest::Client,
}

impl DashHandler {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait::async_trait]
impl ProtocolHandler for DashHandler {
    fn protocol(&self) -> MediaProtocol {
        MediaProtocol::Dash
    }

    async fn resolve_variants(
        &self,
        _url: &str,
        _headers: &[(String, String)],
    ) -> Result<Vec<MediaVariant>, DlmanError> {
        // TODO: Implement MPD XML parsing
        // Libraries to consider: quick-xml, dash-mpd crate
        Err(DlmanError::InvalidOperation(
            "DASH (MPD) protocol support is not yet implemented. \
             Use HLS or direct downloads for now."
                .to_string(),
        ))
    }

    async fn get_segment_urls(
        &self,
        _variant: &MediaVariant,
        _headers: &[(String, String)],
    ) -> Result<Vec<String>, DlmanError> {
        Err(DlmanError::InvalidOperation(
            "DASH (MPD) protocol support is not yet implemented.".to_string(),
        ))
    }
}
