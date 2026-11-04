package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder;
import com.github.tomakehurst.wiremock.extension.ResponseDefinitionTransformerV2;
import com.github.tomakehurst.wiremock.http.DelayDistribution;
import com.github.tomakehurst.wiremock.http.Fault;
import com.github.tomakehurst.wiremock.http.ResponseDefinition;
import com.github.tomakehurst.wiremock.stubbing.ServeEvent;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Applies service-virtualizer behaviour that WireMock cannot express on its own. Enabled per
 * stub by listing "sv" in response.transformers; settings come from
 * response.transformerParameters, written by the control API from a profile:
 *
 * <ul>
 *   <li>svErrors: { rate, responses: [ { status, body, fault, latencyMs, weight } ] }
 *   <li>svConcurrency: { pool, maxConcurrent, maxQueue, queueTimeoutMs, rejectStatus, rejectBody }
 * </ul>
 *
 * Order per request: decide whether this is an injected error; work out its service time; admit
 * it to the capacity pool (which may queue or reject it); then shape the response and delay.
 */
public class SvTransformer implements ResponseDefinitionTransformerV2 {

  public static final String NAME = "sv";
  public static final String INJECTED_HEADER = "X-SV-Injected";
  public static final String REJECTED_HEADER = "X-SV-Rejected";
  public static final String QUEUE_WAIT_HEADER = "X-SV-Queue-Wait-Ms";

  private final AtomicLong evaluated = new AtomicLong();
  private final AtomicLong injected = new AtomicLong();
  private final Map<String, CapacityPool> pools = new ConcurrentHashMap<>();

  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public boolean applyGlobally() {
    return false;
  }

  @Override
  public ResponseDefinition transform(ServeEvent serveEvent) {
    ResponseDefinition original = serveEvent.getResponseDefinition();
    Map<String, Object> params = serveEvent.getTransformerParameters();
    Map<?, ?> errors = params.get("svErrors") instanceof Map<?, ?> m ? m : null;
    Map<?, ?> concurrency = params.get("svConcurrency") instanceof Map<?, ?> m ? m : null;
    if (errors == null && concurrency == null) {
      return original;
    }
    evaluated.incrementAndGet();
    ThreadLocalRandom random = ThreadLocalRandom.current();

    Map<?, ?> error = null;
    if (errors != null) {
      double rate = number(errors.get("rate"), 0);
      if (rate > 0 && random.nextDouble() < rate) {
        error = pick(errors.get("responses"), random);
      }
    }
    Long errorLatency = error != null && error.get("latencyMs") != null ? (long) number(error.get("latencyMs"), 0) : null;

    ResponseDefinitionBuilder builder = ResponseDefinitionBuilder.like(original).but();

    if (concurrency != null) {
      long serviceMs = errorLatency != null ? errorLatency : sampleServiceTime(original);
      CapacityPool pool = pool(concurrency);
      CapacityPool.Admission admission = pool.admit(System.nanoTime() / 1_000_000, serviceMs);
      if (admission.rejected()) {
        Object body = concurrency.get("rejectBody");
        return builder
            .withStatus((int) number(concurrency.get("rejectStatus"), 503))
            .withBody(body == null ? "" : body.toString())
            .withHeader(REJECTED_HEADER, "true")
            .withHeader(QUEUE_WAIT_HEADER, Long.toString(admission.queueWaitMs()))
            .withRandomDelay(null)
            .withFixedDelay((int) admission.delayMs())
            .build();
      }
      // The pool decided the total delay (queue wait + service time), so it replaces any
      // distribution WireMock would otherwise sample.
      builder
          .withRandomDelay(null)
          .withFixedDelay((int) admission.delayMs())
          .withHeader(QUEUE_WAIT_HEADER, Long.toString(admission.queueWaitMs()));
    } else if (errorLatency != null) {
      // Errors often have their own timing: fast 503s, slow gateway timeouts.
      builder.withRandomDelay(null).withFixedDelay(errorLatency.intValue());
    }

    if (error != null) {
      injected.incrementAndGet();
      Object fault = error.get("fault");
      if (fault != null) {
        builder.withFault(Fault.valueOf(fault.toString()));
      } else {
        Object body = error.get("body");
        builder
            .withStatus((int) number(error.get("status"), 500))
            .withBody(body == null ? "" : body.toString())
            .withHeader(INJECTED_HEADER, "true");
      }
    }
    return builder.build();
  }

  Map<String, Object> info() {
    Map<String, Object> info = new LinkedHashMap<>();
    info.put("evaluated", evaluated.get());
    info.put("injected", injected.get());
    Map<String, Object> poolInfo = new LinkedHashMap<>();
    long now = System.nanoTime() / 1_000_000;
    pools.forEach((name, pool) -> poolInfo.put(name, pool.snapshot(now)));
    info.put("pools", poolInfo);
    return info;
  }

  void resetPool(String name) {
    pools.remove(name);
  }

  private CapacityPool pool(Map<?, ?> spec) {
    String name = String.valueOf(spec.get("pool"));
    int maxConcurrent = Math.max(1, (int) number(spec.get("maxConcurrent"), 1));
    int maxQueue = (int) Math.min(Integer.MAX_VALUE, number(spec.get("maxQueue"), Integer.MAX_VALUE));
    long queueTimeoutMs = (long) number(spec.get("queueTimeoutMs"), -1);
    // A changed profile gets a fresh pool; the same profile across stubs shares one.
    return pools.compute(
        name,
        (k, existing) ->
            existing != null && existing.sameConfig(maxConcurrent, maxQueue, queueTimeoutMs)
                ? existing
                : new CapacityPool(maxConcurrent, maxQueue, queueTimeoutMs));
  }

  private static long sampleServiceTime(ResponseDefinition def) {
    long ms = def.getFixedDelayMilliseconds() == null ? 0 : def.getFixedDelayMilliseconds();
    DelayDistribution distribution = def.getDelayDistribution();
    if (distribution != null) {
      ms += distribution.sampleMillis();
    }
    return ms;
  }

  private static Map<?, ?> pick(Object responses, ThreadLocalRandom random) {
    if (!(responses instanceof List<?> list) || list.isEmpty()) {
      return null;
    }
    double total = 0;
    for (Object r : list) {
      total += weight(r);
    }
    double target = random.nextDouble() * total;
    for (Object r : list) {
      target -= weight(r);
      if (target < 0 && r instanceof Map<?, ?> m) {
        return m;
      }
    }
    Object last = list.get(list.size() - 1);
    return last instanceof Map<?, ?> m ? m : null;
  }

  private static double weight(Object response) {
    return response instanceof Map<?, ?> m ? Math.max(0, number(m.get("weight"), 1)) : 0;
  }

  private static double number(Object value, double fallback) {
    if (value instanceof Number n) {
      return n.doubleValue();
    }
    if (value != null) {
      try {
        return Double.parseDouble(value.toString());
      } catch (NumberFormatException ignored) {
        // fall through
      }
    }
    return fallback;
  }
}
