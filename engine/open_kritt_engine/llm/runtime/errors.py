from dataclasses import dataclass, field
from typing import Any


@dataclass
class RuntimeErrorBase(Exception):
    message: str
    code: str
    retryable: bool = False
    details: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.message


class AuthenticationError(RuntimeErrorBase):
    def __init__(self, message: str, **details):
        super().__init__(message, code="authentication_error", retryable=False, details=details)


class CLIAuthenticationRequired(AuthenticationError):
    def __init__(self, message: str = "CLI authentication is required.", **details):
        RuntimeErrorBase.__init__(
            self,
            message,
            code="cli_authentication_required",
            retryable=False,
            details=details,
        )


class CLIUnavailable(RuntimeErrorBase):
    def __init__(self, message: str = "CLI executable is unavailable.", **details):
        super().__init__(message, code="cli_unavailable", retryable=False, details=details)


class TimeoutError(RuntimeErrorBase):
    def __init__(self, message: str = "Runtime execution timed out.", **details):
        super().__init__(message, code="timeout", retryable=True, details=details)


class ModelUnavailable(RuntimeErrorBase):
    def __init__(self, message: str = "Model is unavailable.", **details):
        super().__init__(message, code="model_unavailable", retryable=False, details=details)


class RateLimited(RuntimeErrorBase):
    def __init__(self, message: str = "Provider rate limited the request.", **details):
        if "retry_after_seconds" in details and details["retry_after_seconds"] is not None:
            try:
                details["retry_after_seconds"] = max(0.0, float(details["retry_after_seconds"]))
            except (TypeError, ValueError):
                details["retry_after_seconds"] = None
        super().__init__(message, code="rate_limited", retryable=True, details=details)


class TransportError(RuntimeErrorBase):
    def __init__(self, message: str = "Runtime transport failed.", **details):
        super().__init__(message, code="transport_error", retryable=True, details=details)


class InvalidResponse(RuntimeErrorBase):
    def __init__(self, message: str = "Runtime returned an invalid response.", **details):
        super().__init__(message, code="invalid_response", retryable=False, details=details)


class ProviderConfigurationError(RuntimeErrorBase):
    def __init__(self, message: str = "Provider runtime configuration is invalid.", **details):
        super().__init__(message, code="provider_configuration_error", retryable=False, details=details)
