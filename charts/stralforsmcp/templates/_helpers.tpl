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

{{- define "stralforsmcp.guards" -}}
{{- if le (mul (int .Values.terminationGracePeriodSeconds) 1000) (int .Values.drainMs) -}}{{- fail "stralforsmcp: terminationGracePeriodSeconds must be longer than drainMs (in seconds vs milliseconds)" -}}{{- end -}}
{{- if eq .Values.stralfors.env "prod" -}}
{{- if .Values.stralfors.allowWrite -}}{{- fail "stralforsmcp: stralfors.allowWrite is never allowed with env=prod" -}}{{- end -}}
{{- if .Values.ingress.public.enabled -}}{{- fail "stralforsmcp: public ingress is not allowed with env=prod (ingress.public.enabled)" -}}{{- end -}}
{{- end -}}
{{- end }}

{{- define "stralforsmcp.profileIds" -}}
{{- $ids := list -}}
{{- range .Values.profiles }}{{- $ids = append $ids .id -}}{{- end -}}
{{- join "," $ids -}}
{{- end }}
