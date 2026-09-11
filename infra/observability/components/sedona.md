# Apache Sedona / Spark batch-job telemetry (wave W4 snippet)

Compose service: `sedona` (profile `sedona`, `apache/sedona`, one-shot
`spark-submit --master local[2]` batch job over the MinIO parquet).

Honest status: **PARTIAL — batch only, no request path.** The job runs
seconds-to-minutes then exits; there is no server to scrape.

## OTel Java agent on spark-submit

Add the OpenTelemetry javaagent to driver (and executor) JVMs. Because the
compose image has no agent jar baked in, bake it in a derived image or mount
it via a volume:

```yaml
# environment: additions for the sedona compose service (integrator: W3)
OTEL_SERVICE_NAME: agric-sedona-batch
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_TRACES_EXPORTER: otlp
OTEL_METRICS_EXPORTER: otlp
OTEL_LOGS_EXPORTER: none
OTEL_INSTRUMENTATION_COMMON_EXPERIMENTAL_CONTROLLER_TELEMETRY_ENABLED: "true"
SPARK_SUBMIT_OPTS: >-
  -javaagent:/opt/otel/opentelemetry-javaagent.jar
# Spark config for the driver (the job is local[2], so driver == executor):
#   --conf spark.driver.extraJavaOptions=-javaagent:/opt/otel/opentelemetry-javaagent.jar
```

What you get: JVM metrics + HTTP/JDBC auto-instrumentation around the Spark
driver. What you do NOT get: per-RDD-stage spans — Spark's task execution is
not auto-instrumented; stage/job-level visibility needs a Spark listener
(`SparkListener`) forwarding events as spans/metrics (custom code, out of
scope this wave).

Job success/failure signal: the container exit code + docker events; alert on
"no successful run in N hours" via a scheduled check, not via telemetry.
