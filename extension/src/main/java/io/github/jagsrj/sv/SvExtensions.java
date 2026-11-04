package io.github.jagsrj.sv;

import com.github.tomakehurst.wiremock.extension.Extension;
import com.github.tomakehurst.wiremock.extension.ExtensionFactory;
import com.github.tomakehurst.wiremock.extension.WireMockServices;
import java.util.List;

/** Load with: --extensions io.github.jagsrj.sv.SvExtensions */
public class SvExtensions implements ExtensionFactory {

  public static final String VERSION = "0.3.0";

  @Override
  public List<Extension> create(WireMockServices services) {
    SvErrorInjector injector = new SvErrorInjector();
    return List.of(injector, new SvAdminApi(injector));
  }
}
