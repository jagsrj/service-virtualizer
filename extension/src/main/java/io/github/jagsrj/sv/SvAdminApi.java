package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.admin.Router;
import com.github.tomakehurst.wiremock.extension.AdminApiExtension;
import com.github.tomakehurst.wiremock.http.RequestMethod;
import com.github.tomakehurst.wiremock.http.ResponseDefinition;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * GET /__admin/sv/info: extension version, error counts and live capacity-pool state.
 * DELETE /__admin/sv/pools/{name}: forget a pool's state (used when a profile is reset).
 */
public class SvAdminApi implements AdminApiExtension {

  private final SvTransformer transformer;

  public SvAdminApi(SvTransformer transformer) {
    this.transformer = transformer;
  }

  @Override
  public String getName() {
    return "sv-admin";
  }

  @Override
  public void contributeAdminApiRoutes(Router router) {
    router.add(
        RequestMethod.GET,
        "/sv/info",
        (admin, serveEvent, pathParams) -> {
          Map<String, Object> info = new LinkedHashMap<>();
          info.put("extension", "service-virtualizer");
          info.put("version", SvExtensions.VERSION);
          info.put("transformer", SvTransformer.NAME);
          info.putAll(transformer.info());
          return ResponseDefinition.okForJson(info);
        });
    router.add(
        RequestMethod.DELETE,
        "/sv/pools/{name}",
        (admin, serveEvent, pathParams) -> {
          transformer.resetPool(pathParams.get("name"));
          return ResponseDefinition.okEmptyJson();
        });
  }
}
