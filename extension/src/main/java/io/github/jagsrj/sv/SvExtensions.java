package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.extension.Extension;
import com.github.tomakehurst.wiremock.extension.ExtensionFactory;
import com.github.tomakehurst.wiremock.extension.WireMockServices;
import java.util.List;

/** Registered through META-INF/services: putting the jar on WireMock's classpath is enough. */
public class SvExtensions implements ExtensionFactory {

  public static final String VERSION = "0.5.0";

  @Override
  public List<Extension> create(WireMockServices services) {
    SvTransformer transformer = new SvTransformer();
    SvMetrics metrics = new SvMetrics();
    return List.of(transformer, metrics, new SvAdminApi(transformer, metrics));
  }
}
