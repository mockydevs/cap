//! Audio container detection by magic bytes. The declared content type is
//! never trusted on its own.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioContainer {
    WebM,
    Ogg,
    Wav,
    Flac,
}

impl AudioContainer {
    pub fn extension(self) -> &'static str {
        match self {
            AudioContainer::WebM => "webm",
            AudioContainer::Ogg => "ogg",
            AudioContainer::Wav => "wav",
            AudioContainer::Flac => "flac",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            AudioContainer::WebM => "audio/webm",
            AudioContainer::Ogg => "audio/ogg",
            AudioContainer::Wav => "audio/wav",
            AudioContainer::Flac => "audio/flac",
        }
    }

    pub fn from_extension(ext: &str) -> Option<Self> {
        Some(match ext {
            "webm" => AudioContainer::WebM,
            "ogg" => AudioContainer::Ogg,
            "wav" => AudioContainer::Wav,
            "flac" => AudioContainer::Flac,
            _ => return None,
        })
    }
}

pub fn sniff(bytes: &[u8]) -> Option<AudioContainer> {
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some(AudioContainer::WebM)
    } else if bytes.starts_with(b"OggS") {
        Some(AudioContainer::Ogg)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        Some(AudioContainer::Wav)
    } else if bytes.starts_with(b"fLaC") {
        Some(AudioContainer::Flac)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_containers_only() {
        assert_eq!(
            sniff(&[0x1A, 0x45, 0xDF, 0xA3, 0]),
            Some(AudioContainer::WebM)
        );
        assert_eq!(sniff(b"OggS\0\x02"), Some(AudioContainer::Ogg));
        assert_eq!(sniff(b"RIFF\0\0\0\0WAVEfmt "), Some(AudioContainer::Wav));
        assert_eq!(sniff(b"fLaC\0"), Some(AudioContainer::Flac));
        for bad in [
            &b"<html>"[..],
            b"<svg",
            b"RIFF\0\0\0\0AVI ",
            b"",
            b"\x89PNG",
        ] {
            assert_eq!(sniff(bad), None);
        }
    }
}
