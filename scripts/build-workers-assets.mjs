import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

// Bundles pinned official Scramjet browser artifacts into Cloudflare Assets.
const root = process.cwd();
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
for (const [pkg, source, dest] of artifacts) {
  const sourceFile = join(root, "node_modules", ...pkg.split("/"), source);
  const targetFile = join(root, "public", dest);
  await mkdir(dirname(targetFile), { recursive: true });
  await cp(sourceFile, targetFile);
  const contents = await readFile(targetFile);
  console.log(dest, createHash("sha256").update(contents).digest("hex").slice(0, 16));
}
await writeFile(join(root,"public","bootstrap-init.js"), `async function initBootstrap() {
  const { init } = await import("/bootstrap-client.js");
  return init({
    transport: "libcurl",
    swPath: "/sw.js",
    wispPath: "/wisp/",
    bootstrapInitPath: "/bootstrap-init.js",
    scramjetBundlePath: "/scram/scramjet.js",
    scramjetWasmPath: "/scram/scramjet.wasm",
    scramjetUtilsBundlePath: "/scram/scramjet-utils.js",
    scramjetControllerApiPath: "/controller/controller.api.js",
    scramjetControllerInjectPath: "/controller/controller.inject.js",
    scramjetControllerSwPath: "/controller/controller.sw.js",
    libcurlClientPath: "/clients/libcurl-client.js"
  });
}\n`);
console.log("Assets copied. A compatible Wisp backend is still required.");
