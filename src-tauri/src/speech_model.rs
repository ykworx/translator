#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechModel { Medium, Turbo, Large }

impl SpeechModel {
    pub fn parse(id: &str) -> Result<Self, String> {
        match id {
            "medium" => Ok(Self::Medium),
            "large-v3-turbo" => Ok(Self::Turbo),
            "large-v3" => Ok(Self::Large),
            _ => Err(format!("지원하지 않는 음성 모델입니다: {id}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self { Self::Medium => "medium", Self::Turbo => "large-v3-turbo", Self::Large => "large-v3" }
    }

    pub fn cache_id(self) -> u8 {
        match self { Self::Medium => 1, Self::Turbo => 2, Self::Large => 3 }
    }

    pub fn ggml_filename(self) -> String { format!("ggml-{}.bin", self.id()) }
    pub fn encoder_dir(self) -> String { format!("ggml-{}-encoder.mlmodelc", self.id()) }
    pub fn encoder_filename(self) -> String { format!("{}.zip", self.encoder_dir()) }
    pub fn download_url(self, encoder: bool) -> String {
        let filename = if encoder { self.encoder_filename() } else { self.ggml_filename() };
        format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{filename}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_uses_its_own_matching_encoder_and_cache_key() {
        let mut keys = std::collections::HashSet::new();
        for id in ["medium", "large-v3-turbo", "large-v3"] {
            let model = SpeechModel::parse(id).unwrap();
            assert_eq!(model.ggml_filename(), format!("ggml-{id}.bin"));
            assert_eq!(model.encoder_filename(), format!("ggml-{id}-encoder.mlmodelc.zip"));
            assert!(keys.insert(model.cache_id()));
            assert!(model.download_url(true).starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"));
        }
    }

    #[test]
    fn arbitrary_paths_and_model_names_cannot_reach_the_download_api() {
        for id in ["", "../large-v3", "https://example.com/model", "large", "medium.en"] {
            assert!(SpeechModel::parse(id).is_err());
        }
    }
}
