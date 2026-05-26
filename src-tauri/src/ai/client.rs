use crate::ai::types::{
    ChatCompletionRequest, ChatCompletionResponse, Message, StreamChunk, AiError,
};
use futures_util::StreamExt;
use reqwest;
use std::time::Duration;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AIClient {
    client: reqwest::Client,
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
}

impl AIClient {
    pub fn new(
        provider: &str,
        endpoint: &str,
        api_key: &str,
        model: &str,
    ) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| AiError::ConfigError(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            client,
            provider: provider.to_string(),
            endpoint: endpoint.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
        })
    }

    /// Send chat request and get response
    pub async fn chat(&self, messages: &[Message]) -> Result<String, AiError> {
        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: messages.to_vec(),
            temperature: Some(0.3),
            stream: Some(false),
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.endpoint))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::HttpError(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(AiError::ApiError(format!(
                "API error ({}): {}",
                status, body
            )));
        }

        let result: ChatCompletionResponse = response
            .json()
            .await
            .map_err(|e| AiError::JsonError(format!("Failed to parse response: {}", e)))?;

        if let Some(choice) = result.choices.first() {
            Ok(choice.message.content.clone())
        } else {
            Err(AiError::ApiError("No response from AI".to_string()))
        }
    }

    /// Send chat request with streaming support.
    /// Uses byte-stream to process SSE chunks incrementally without buffering
    /// the entire response in memory.
    pub async fn chat_stream(
        &self,
        messages: &[Message],
        tx: tokio::sync::mpsc::Sender<String>,
    ) -> Result<(), AiError> {
        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: messages.to_vec(),
            temperature: Some(0.3),
            stream: Some(true),
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.endpoint))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await
            .map_err(|e| AiError::HttpError(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(AiError::ApiError(format!(
                "API error ({}): {}",
                status, body
            )));
        }

        // Process SSE chunks incrementally via byte stream
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AiError::StreamError(format!("Stream error: {}", e)))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process complete lines from buffer
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer.drain(..=pos);

                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) {
                        if let Some(choice) = parsed.choices.first() {
                            if let Some(content) = &choice.delta.content {
                                if tx.send(content.clone()).await.is_err() {
                                    return Ok(()); // receiver dropped, stop gracefully
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Send a raw JSON request and get the raw text response back.
    /// Used by the agent loop which constructs its own request format.
    pub async fn chat_raw(&self, request: &serde_json::Value) -> Result<String, AiError> {
        let response = self
            .client
            .post(format!("{}/chat/completions", self.endpoint))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(request)
            .send()
            .await
            .map_err(|e| AiError::HttpError(format!("Request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(AiError::ApiError(format!("API error ({}): {}", status, body)));
        }

        response.text().await
            .map_err(|e| AiError::StreamError(format!("Failed to read response: {}", e)))
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn get_provider(&self) -> &str {
        &self.provider
    }

    pub fn get_model(&self) -> &str {
        &self.model
    }
}
