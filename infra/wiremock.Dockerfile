# WireMock with the service-virtualizer extension (percentage error injection).
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY extension/pom.xml .
RUN mvn -q dependency:go-offline
COPY extension/src ./src
RUN mvn -q package

FROM wiremock/wiremock:3.13.2
# Jars in /var/wiremock/extensions are on WireMock's classpath; the extension
# registers itself through META-INF/services, so no --extensions flag is needed.
COPY --from=build /build/target/sv-wiremock-extension.jar /var/wiremock/extensions/
