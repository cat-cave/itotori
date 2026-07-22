use super::*;

impl OffsetMapValidationResult {
    pub fn from_diagnostics(diagnostics: Vec<OffsetMapDiagnostic>) -> Self {
        Self {
            schema_version: "0.1.0".to_string(),
            status: if diagnostics.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            diagnostics,
        }
    }

    pub fn into_result(self) -> Result<(), OffsetMapError> {
        if self.status == OperationStatus::Passed {
            Ok(())
        } else {
            Err(OffsetMapError {
                diagnostics: self.diagnostics,
            })
        }
    }
}

impl OffsetMapDiagnostic {
    pub fn new(
        code: impl Into<String>,
        field: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            field: field.into(),
            message: message.into(),
        }
    }
}

impl OffsetMapError {
    pub fn from_diagnostic(diagnostic: OffsetMapDiagnostic) -> Self {
        Self {
            diagnostics: vec![diagnostic],
        }
    }

    pub fn diagnostics(&self) -> &[OffsetMapDiagnostic] {
        &self.diagnostics
    }
}

impl fmt::Display for OffsetMapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let messages = self
            .diagnostics
            .iter()
            .map(|diagnostic| {
                format!(
                    "{} at {}: {}",
                    diagnostic.code, diagnostic.field, diagnostic.message
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        formatter.write_str(&messages)
    }
}

impl std::error::Error for OffsetMapError {}
