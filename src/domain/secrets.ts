// Names that look like they hold a secret. Shared by the service's redaction (server/redact.ts) and
// by the domain's validation of check settings, so both agree on what never reaches a
// worker or a log. Pure: no runtime dependencies.

export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
