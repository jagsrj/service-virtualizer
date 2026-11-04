package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder;
import com.github.tomakehurst.wiremock.extension.ResponseDefinitionTransformerV2;
import com.github.tomakehurst.wiremock.http.Fault;
import com.github.tomakehurst.wiremock.http.ResponseDefinition;
import com.github.tomakehurst.wiremock.stubbing.ServeEvent;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Turns a configured fraction of a stub's responses into errors.
 *
 * <p>Enabled per stub by listing "sv-errors" in response.transformers, with settings in
 * response.transformerParameters.svErrors:
 *
 * <pre>
 * { "rate": 0.02,
 *   "responses": [
 *     { "status": 500, "body": "...", "weight": 3 },
 *     { "status": 504, "latencyMs": 10000, "weight": 1 },
 *     { "fault": "CONNECTION_RESET_BY_PEER", "weight": 1 } ] }
 * </pre>
 *
 * The service-virtualizer control API writes these settings from a profile's "errors"
 * section; stubs never need to be edited by hand.
 */
public class SvErrorInjector implements ResponseDefinitionTransformerV2 {

  public static final String NAME = "sv-errors";
  public static final String PARAMS_KEY = "svErrors";
  public static final String INJECTED_HEADER = "X-SV-Injected";

  private final AtomicLong evaluated = new AtomicLong();
  private final AtomicLong injected = new AtomicLong();

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
    Object raw = serveEvent.getTransformerParameters().get(PARAMS_KEY);
    if (!(raw instanceof Map<?, ?> spec)) {
      return original;
    }
    evaluated.incrementAndGet();

    double rate = number(spec.get("rate"), 0);
    ThreadLocalRandom random = ThreadLocalRandom.current();
    if (rate <= 0 || random.nextDouble() >= rate) {
      return original;
    }
    Map<?, ?> choice = pick(spec.get("responses"), random);
    if (choice == null) {
      return original;
    }
    injected.incrementAndGet();

    ResponseDefinitionBuilder builder = ResponseDefinitionBuilder.like(original).but();
    Object fault = choice.get("fault");
    if (fault != null) {
      builder.withFault(Fault.valueOf(fault.toString()));
    } else {
      builder.withStatus((int) number(choice.get("status"), 500));
      Object body = choice.get("body");
      builder.withBody(body == null ? "" : body.toString());
      builder.withHeader(INJECTED_HEADER, "true");
    }
    Object latency = choice.get("latencyMs");
    if (latency != null) {
      // Errors often have their own timing: fast 503s, slow gateway timeouts.
      builder.withRandomDelay(null).withFixedDelay((int) number(latency, 0));
    }
    return builder.build();
  }

  long evaluated() {
    return evaluated.get();
  }

  long injected() {
    return injected.get();
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
