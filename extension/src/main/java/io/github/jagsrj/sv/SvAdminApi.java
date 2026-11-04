package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.admin.Router;
import com.github.tomakehurst.wiremock.extension.AdminApiExtension;
import com.github.tomakehurst.wiremock.http.RequestMethod;
import com.github.tomakehurst.wiremock.http.ResponseDefinition;
import java.util.LinkedHashMap;
import java.util.Map;

/** GET /__admin/sv/info: lets the control API confirm the extension is loaded. */
public class SvAdminApi implements AdminApiExtension {

  private final SvErrorInjector injector;

  public SvAdminApi(SvErrorInjector injector) {
    this.injector = injector;
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
          info.put("transformer", SvErrorInjector.NAME);
          info.put("evaluated", injector.evaluated());
          info.put("injected", injector.injected());
          return ResponseDefinition.okForJson(info);
        });
  }
}
