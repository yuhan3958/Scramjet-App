import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const artifacts = [
  ["@mercuryworkshop/proxy-bootstrap", "dist/bootstrap-client.js", "bootstrap-client.js"],
  ["@mercuryworkshop/scramjet", "dist/scramjet.js", "scram/scramjet.js"],
  ["@mercuryworkshop/scramjet", "dist/scramjet.wasm", "scram/scramjet.wasm"],
  ["@mercuryworkshop/scramjet-controller", "dist/controller.api.js", "controller/controller.api.js"],
  ["@mercuryworkshop/scramjet-controller", "dist/controller.inject.js", "controller/controller.inject.js"],
  ["@mercuryworkshop/scramjet-controller", "dist/controller.sw.js", "controller/controller.sw.js"],
  ["@mercuryworkshop/scramjet-utils", "dist/scramjet-utils.js", "scram/scramjet-utils.js"],
  ["@mercuryworkshop/libcurl-transport", "dist/index.js", "clients/libcurl-client.js"],
];
for (const [pkg, src, dst] of artifacts) {
  const source = join("node_modules", pkg, src);
  const target = join("public", dst);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log("Staged", target);
}
await writeFile("public/bootstrap-init.js", `async function initBootstrap() {
  const { init } = await import("/bootstrap-client.js");
  return init({
    transport: "libcurl", swPath: "/sw.js", wispPath: "/wisp/",
    scramjetBundlePath: "/scram/scramjet.js",
    scramjetWasmPath: "/scram/scramjet.wasm",
    scramjetUtilsBundlePath: "/scram/scramjet-utils.js",
    scramjetControllerApiPath: "/controller/controller.api.js",
    scramjetControllerInjectPath: "/controller/controller.inject.js",
    scramjetControllerSwPath: "/controller/controller.sw.js",
    libcurlClientPath: "/clients/libcurl-client.js",
  });
}\n`);
await writeFile("public/sw.js", `importScripts("/controller/controller.sw.js");
addEventListener("fetch", event => {
  if (self.$scramjetController?.shouldRoute(event)) {
    event.respondWith(self.$scramjetController.route(event));
  }
});\n`);
console.log("Browser assets staged");
