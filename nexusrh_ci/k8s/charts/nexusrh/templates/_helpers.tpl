{{/*
_helpers.tpl — Fonctions communes NexusRH chart
*/}}

{{/* Nom complet release */}}
{{- define "nexusrh.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Namespace */}}
{{- define "nexusrh.namespace" -}}
{{- .Values.global.namespace | default .Release.Namespace }}
{{- end }}

{{/* Labels communs */}}
{{- define "nexusrh.labels" -}}
app.kubernetes.io/part-of: nexusrh
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Labels sélecteur par composant */}}
{{- define "nexusrh.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ . }}
{{- end }}

{{/* securityContext pod (OWASP A05) */}}
{{- define "nexusrh.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .runAsUser | default 1001 }}
runAsGroup: {{ .runAsGroup | default 1001 }}
fsGroup: {{ .fsGroup | default 1001 }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/* securityContext container */}}
{{- define "nexusrh.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .readOnly | default true }}
capabilities:
  drop: [ALL]
{{- end }}

{{/* URL interne PostgreSQL */}}
{{- define "nexusrh.postgresUrl" -}}
postgresql://nexusrh:$(POSTGRES_PASSWORD)@{{ .Release.Name }}-postgres-postgresql.{{ include "nexusrh.namespace" . }}.svc.cluster.local:5432/nexusrh
{{- end }}

{{/* URL interne Redis */}}
{{- define "nexusrh.redisUrl" -}}
redis://:$(REDIS_PASSWORD)@{{ .Release.Name }}-redis-master.{{ include "nexusrh.namespace" . }}.svc.cluster.local:6379
{{- end }}

{{/* URL interne MinIO */}}
{{- define "nexusrh.minioEndpoint" -}}
http://{{ .Release.Name }}-minio.{{ include "nexusrh.namespace" . }}.svc.cluster.local:9000
{{- end }}

{{/* URL interne Meilisearch */}}
{{- define "nexusrh.meilisearchUrl" -}}
http://{{ .Release.Name }}-meilisearch.{{ include "nexusrh.namespace" . }}.svc.cluster.local:7700
{{- end }}
