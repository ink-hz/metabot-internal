# Provider timeout recovery rollout

MetaBot retries a transient provider turn once at the turn coordinator only when no replay-blocking tool effect was observed. The loopback HTTP adapter never retries POST requests.

## Timeout contract

The compatibility runtime injects `API_TIMEOUT_MS=300000` by default. A deployment may set `METABOT_CLAUDE_API_TIMEOUT_MS=600000` only after verifying the same upstream and intermediary proxy path for at least 600 seconds. The runtime rejects the 600-second value unless `METABOT_PROVIDER_STREAM_LIFETIME_VERIFIED=true` is also set.

Use a dedicated streaming canary endpoint that traverses the same load balancer, reverse proxy, and upstream connection policy as `/v1/messages`. The canary must accept the fixed, content-free probe body and must not persist credentials or request content.

```bash
npm run probe:provider-stream-lifetime -- --dry-run

PROVIDER_STREAM_PROBE_URL=https://canary.example/internal/stream-lifetime \
PROVIDER_STREAM_PROBE_TOKEN=... \
npm run probe:provider-stream-lifetime
```

The live probe prints only duration evidence. It never prints the URL, token, headers, or response body. A passing probe must remain open for at least 600,000 ms. Heartbeats no more than 60,000 ms apart are reported as an additional contract signal, but a short stream never passes merely because it emitted heartbeats.

After a passing probe, record the evidence in the deployment change, set both rollout variables, restart only the isolated Bot instance, and run a synthetic staging-chat task before any real-user smoke test. If the probe fails or the path cannot be verified, retain 300,000 ms; the error propagation, one-retry coordinator, and staged artifact workflow provide the primary resilience.
