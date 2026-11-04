#!/usr/bin/env bash
# Builds the extension jar with plain javac (no Maven needed).
# Usage: WIREMOCK_JAR=/path/to/wiremock-standalone-3.x.jar ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${WIREMOCK_JAR:?Set WIREMOCK_JAR to the WireMock standalone jar}"
rm -rf target/classes && mkdir -p target/classes
javac --release 17 -cp "$WIREMOCK_JAR" -d target/classes $(find src/main/java -name '*.java')
cp -r src/main/resources/. target/classes/
jar --create --file target/sv-wiremock-extension.jar -C target/classes .
echo "Built target/sv-wiremock-extension.jar"
