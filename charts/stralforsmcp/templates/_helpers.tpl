{{/* Base is cut to 54 so the longest suffix appended (-internal, 9) still fits 63. */}}
{{- define "stralforsmcp.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 54 | trimSuffix "-" }}{{ else }}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 54 | trimSuffix "-" }}{{ end -}}
{{- end }}

{{- define "stralforsmcp.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "stralforsmcp.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Union of all ingress hosts and extraHostnames; fails when empty or when prod meets a public ingress. */}}
{{- define "stralforsmcp.hostnames" -}}
{{- $h := list -}}
{{- range $k := list "internal" "public" -}}
{{- $i := index $.Values.ingress $k -}}
{{- if $i.enabled -}}{{- range $i.hosts -}}{{- $h = append $h .host -}}{{- end -}}{{- end -}}
{{- end -}}
{{- $h = concat $h (compact (default (list) .Values.extraHostnames)) | compact | uniq -}}
{{- if not $h -}}{{- fail "stralforsmcp: at least one hostname is required (enable an ingress with hosts or set extraHostnames)" -}}{{- end -}}
{{- join "," $h -}}
{{- end }}

{{/* Env names the chart sets itself or ties to its fixed ports and binds (probes, Services and the NetworkPolicy assume 3000 and 9464 on all interfaces); extraEnv may not set them. */}}
{{- define "stralforsmcp.reservedEnv" -}}
STRALFORS_ENV STRALFORS_PROFILES STRALFORS_ALLOW_WRITE STRALFORS_PROD_VALIDATE_ENABLED STRALFORS_CERT_RELOAD_S STRALFORS_TIMEOUT_MS MCP_TOKEN_LIST_FILE MCP_HOSTNAMES MCP_ORIGINS MCP_DRAIN_MS MCP_READY_DELAY_MS MCP_LOG_LEVEL MCP_RATE_PER_MINUTE MCP_RATE_BURST NODE_OPTIONS MCP_PORT MCP_LISTEN_HOST MCP_METRICS_PORT MCP_METRICS_HOST KNOWLEDGE_DIRS KNOWLEDGE_PUBLIC_DIR OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS
{{- end }}

{{- define "stralforsmcp.guards" -}}
{{- /* Shutdown budget (ADR 0023): ready delay + drain + 3 s client close + 5 s telemetry flush must fit inside the grace period. */ -}}
{{- if le (mul (int .Values.terminationGracePeriodSeconds) 1000) (add (int .Values.readyDelayMs) (int .Values.drainMs) 8000) -}}{{- fail "stralforsmcp: terminationGracePeriodSeconds * 1000 must exceed readyDelayMs + drainMs + 8000 (3 s client close + 5 s telemetry flush); raise terminationGracePeriodSeconds or lower readyDelayMs/drainMs" -}}{{- end -}}
{{- $reserved := splitList " " (include "stralforsmcp.reservedEnv" .) -}}
{{- range .Values.extraEnv -}}
{{- if or (has .name $reserved) (hasPrefix "STRALFORS_PROFILE_" .name) (hasPrefix "OTEL_EXPORTER_OTLP_" .name) -}}{{- fail (printf "stralforsmcp: extraEnv must not set %s: it is reserved by the chart (see the chart README)" .name) -}}{{- end -}}
{{- end -}}
{{- $own := list "token-list" -}}
{{- range .Values.profiles }}{{- $own = append $own (printf "creds-%s" .id) -}}{{- end -}}
{{- range .Values.extraVolumes -}}
{{- if has .name $own -}}{{- fail (printf "stralforsmcp: extraVolumes name %s is used by the chart" .name) -}}{{- end -}}
{{- end -}}
{{- range .Values.extraVolumeMounts -}}
{{- if has .name $own -}}{{- fail (printf "stralforsmcp: extraVolumeMounts name %s is used by the chart" .name) -}}{{- end -}}
{{- if hasPrefix "/run/creds" .mountPath -}}{{- fail (printf "stralforsmcp: extraVolumeMounts mountPath %s is under /run/creds, which the chart owns" .mountPath) -}}{{- end -}}
{{- end -}}
{{- if eq .Values.stralfors.env "prod" -}}
{{- if .Values.stralfors.allowWrite -}}{{- fail "stralforsmcp: stralfors.allowWrite is never allowed with env=prod" -}}{{- end -}}
{{- if .Values.ingress.public.enabled -}}{{- fail "stralforsmcp: public ingress is not allowed with env=prod (ingress.public.enabled)" -}}{{- end -}}
{{- if not .Values.ingress.internal.enabled -}}{{- fail "stralforsmcp: env=prod requires ingress.internal.enabled=true" -}}{{- end -}}
{{- if not .Values.ingress.internal.className -}}{{- fail "stralforsmcp: env=prod requires ingress.internal.className (the class the operator exposes only internally)" -}}{{- end -}}
{{- if compact (default (list) .Values.extraHostnames) -}}{{- fail "stralforsmcp: env=prod does not allow extraHostnames; hostnames come only from the internal ingress" -}}{{- end -}}
{{- end -}}
{{- end }}

{{- define "stralforsmcp.profileIds" -}}
{{- $ids := list -}}
{{- range .Values.profiles }}{{- $ids = append $ids .id -}}{{- end -}}
{{- join "," $ids -}}
{{- end }}
