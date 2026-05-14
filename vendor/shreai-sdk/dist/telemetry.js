import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
export function initTelemetry(serviceName, config = {}) {
    const endpoint = config.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
    if (config.debug) {
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }
    const resource = new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: config.version || '0.0.0',
        'deployment.environment': process.env.NODE_ENV || 'development',
        'service.namespace': 'shre-ai',
    });
    const traceExporter = new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
    });
    const metricExporter = new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
    });
    const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metricIntervalMs ?? 30_000,
    });
    const sdk = new NodeSDK({
        resource,
        traceExporter,
        metricReader,
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-http': { enabled: true },
                '@opentelemetry/instrumentation-net': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-fs': { enabled: false },
            }),
        ],
    });
    sdk.start();
    return async () => {
        await sdk.shutdown();
    };
}
