package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.extension.Parameters;
import com.github.tomakehurst.wiremock.extension.ServeEventListener;
import com.github.tomakehurst.wiremock.http.HttpHeaders;
import com.github.tomakehurst.wiremock.http.LoggedResponse;
import com.github.tomakehurst.wiremock.stubbing.ServeEvent;
import com.github.tomakehurst.wiremock.stubbing.StubMapping;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Per-service metrics for every request WireMock serves, summarised per interval.
 *
 * <p>Sees every request (it doesn't depend on the request journal, which is bounded and can be
 * turned off under load). The control API drains an interval every few seconds through
 * GET /__admin/sv/metrics and writes it to InfluxDB. Latency percentiles come from a uniform
 * reservoir sample (up to 10,000 requests per service per interval); count, mean and max are exact.
 */
public class SvMetrics implements ServeEventListener {

  static final int RESERVOIR = 10_000;

  private final AtomicReference<Interval> current = new AtomicReference<>(new Interval());

  @Override
  public String getName() {
    return "sv-metrics";
  }

  @Override
  public boolean applyGlobally() {
    return true;
  }

  @Override
  public void afterComplete(ServeEvent event, Parameters parameters) {
    String service = serviceOf(event);
    if (service == null) {
      return; // admin API calls and similar
    }
    LoggedResponse response = event.getResponse();
    Integer total = event.getTiming() == null ? null : event.getTiming().getTotalTime();
    current.get().stats(service).record(response, total == null ? 0 : total);
  }

  /** Returns the interval collected since the last drain and starts a new one. */
  Map<String, Object> drain() {
    Interval finished = current.getAndSet(new Interval());
    long end = System.currentTimeMillis();
    Map<String, Object> services = new LinkedHashMap<>();
    finished.services.forEach((name, stats) -> services.put(name, stats.summary()));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("intervalStart", finished.startMs);
    out.put("intervalEnd", end);
    out.put("services", services);
    return out;
  }

  private static String serviceOf(ServeEvent event) {
    if (!event.getWasMatched()) {
      return "unmatched";
    }
    StubMapping stub = event.getStubMapping();
    if (stub == null) {
      return null;
    }
    if (stub.getMetadata() != null) {
      String service = stub.getMetadata().getString("service", null);
      if (service != null) {
        return service;
      }
    }
    // Proxied traffic during a recording has no service tag yet.
    return stub.getResponse() != null && stub.getResponse().getProxyBaseUrl() != null ? "recording" : "untagged";
  }

  private static final class Interval {
    final long startMs = System.currentTimeMillis();
    final Map<String, ServiceStats> services = new ConcurrentHashMap<>();

    ServiceStats stats(String service) {
      return services.computeIfAbsent(service, s -> new ServiceStats());
    }
  }

  private static final class ServiceStats {
    private long count;
    private long status2xx;
    private long status3xx;
    private long status4xx;
    private long status5xx;
    private long faults;
    private long injected;
    private long rejected;
    private long latencySum;
    private long latencyMax;
    private long queueWaitSum;
    private long queueWaitMax;
    private long queueWaitCount;
    private final long[] reservoir = new long[RESERVOIR];

    synchronized void record(LoggedResponse response, long latencyMs) {
      count++;
      latencySum += latencyMs;
      latencyMax = Math.max(latencyMax, latencyMs);
      if (count <= RESERVOIR) {
        reservoir[(int) count - 1] = latencyMs;
      } else {
        long slot = ThreadLocalRandom.current().nextLong(count);
        if (slot < RESERVOIR) {
          reservoir[(int) slot] = latencyMs;
        }
      }
      if (response == null) {
        return;
      }
      if (response.getFault() != null) {
        faults++;
      } else {
        int status = response.getStatus();
        if (status >= 500) status5xx++;
        else if (status >= 400) status4xx++;
        else if (status >= 300) status3xx++;
        else status2xx++;
      }
      HttpHeaders headers = response.getHeaders();
      boolean isRejected = has(headers, SvTransformer.REJECTED_HEADER);
      if (isRejected) {
        rejected++;
      } else if (has(headers, SvTransformer.INJECTED_HEADER)) {
        injected++;
      }
      if (!isRejected && headers != null && headers.getHeader(SvTransformer.QUEUE_WAIT_HEADER).isPresent()) {
        try {
          long wait = Long.parseLong(headers.getHeader(SvTransformer.QUEUE_WAIT_HEADER).firstValue());
          queueWaitSum += wait;
          queueWaitMax = Math.max(queueWaitMax, wait);
          queueWaitCount++;
        } catch (NumberFormatException ignored) {
          // not ours
        }
      }
    }

    synchronized Map<String, Object> summary() {
      int n = (int) Math.min(count, RESERVOIR);
      long[] sample = Arrays.copyOf(reservoir, n);
      Arrays.sort(sample);
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("count", count);
      m.put("status2xx", status2xx);
      m.put("status3xx", status3xx);
      m.put("status4xx", status4xx);
      m.put("status5xx", status5xx);
      m.put("faults", faults);
      m.put("injected", injected);
      m.put("rejected", rejected);
      m.put("latencyMean", count == 0 ? 0 : (double) latencySum / count);
      m.put("latencyP50", percentile(sample, 0.50));
      m.put("latencyP90", percentile(sample, 0.90));
      m.put("latencyP95", percentile(sample, 0.95));
      m.put("latencyP99", percentile(sample, 0.99));
      m.put("latencyMax", latencyMax);
      m.put("queueWaitMean", queueWaitCount == 0 ? 0 : (double) queueWaitSum / queueWaitCount);
      m.put("queueWaitMax", queueWaitMax);
      return m;
    }

    private static boolean has(HttpHeaders headers, String name) {
      return headers != null && headers.getHeader(name).isPresent();
    }

    private static long percentile(long[] sorted, double q) {
      if (sorted.length == 0) return 0;
      int rank = (int) Math.ceil(q * sorted.length);
      return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
    }
  }
}
