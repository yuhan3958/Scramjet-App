import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const accessKey = process.env.PROXY_ACCESS_KEY || "";
const accessCookieName = "__Host-sj_access";
const accessToken = accessKey
	? createHash("sha256")
			.update(`scramjet-access:\0${accessKey}`)
			.digest("base64url")
	: "";

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	allow_private_ips: false,
	allow_loopback_ips: false,
	allow_direct_ip: false,
});

const { routeRequest } = await bootstrap({
	transport: "libcurl",
});

function parseCookies(header = "") {
	return Object.fromEntries(
		header
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const index = part.indexOf("=");
				if (index === -1) return [part, ""];
				return [part.slice(0, index), part.slice(index + 1)];
			}),
	);
}

function safeEqual(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

function hasAccess(req) {
	if (!accessKey) return true;
	const cookies = parseCookies(req.headers.cookie || "");
	return safeEqual(cookies[accessCookieName] || "", accessToken);
}

function expectedOrigin(req) {
	const forwardedHost = req.headers["x-forwarded-host"];
	const rawHost = Array.isArray(forwardedHost)
		? forwardedHost[0]
		: forwardedHost || req.headers.host;
	const host = String(rawHost || "").split(",")[0].trim();

	const forwardedProto = req.headers["x-forwarded-proto"];
	const rawProto = Array.isArray(forwardedProto)
		? forwardedProto[0]
		: forwardedProto;
	const proto = String(rawProto || (host.startsWith("localhost") ? "http" : "https"))
		.split(",")[0]
		.trim();

	return host ? `${proto}://${host}` : null;
}

function isSameOriginWebSocket(req) {
	const origin = req.headers.origin;
	const expected = expectedOrigin(req);
	if (!origin || !expected) return false;

	try {
		return new URL(origin).origin === new URL(expected).origin;
	} catch {
		return false;
	}
}

const unlockHtml = `<!doctype html>
<html lang="ko">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta name="robots" content="noindex">
	<title>Private Proxy</title>
	<style>
		body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#fff;font:16px system-ui,sans-serif}
		form{width:min(360px,calc(100vw - 32px));display:grid;gap:12px}
		input,button{box-sizing:border-box;width:100%;min-height:46px;border-radius:10px;border:1px solid #444;padding:0 12px;font:inherit}
		input{background:#18181b;color:#fff}button{border:0;background:#1a73e8;color:#fff;font-weight:700}
		p{margin:0;color:#bbb;font-size:13px;line-height:1.5}.error{color:#ff8d8d}
	</style>
</head>
<body>
	<form id="unlock">
		<strong>Scramjet Private Proxy</strong>
		<p>Railway의 PROXY_ACCESS_KEY 값을 입력하세요.</p>
		<input id="key" type="password" autocomplete="current-password" required>
		<button type="submit">열기</button>
		<p id="status"></p>
	</form>
	<script>
		const form=document.getElementById("unlock");
		const key=document.getElementById("key");
		const status=document.getElementById("status");
		form.addEventListener("submit",async(e)=>{
			e.preventDefault();
			status.textContent="";
			const res=await fetch("/__unlock",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:key.value}),credentials:"same-origin"});
			key.value="";
			if(res.ok){location.replace("/");return;}
			status.className="error";
			status.textContent="접근 키가 맞지 않습니다.";
		});
	</script>
</body>
</html>`;

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				res.setHeader("Referrer-Policy", "no-referrer");
				res.setHeader("X-Content-Type-Options", "nosniff");

				if (routeRequest(req, res)) return;
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (
					req.url?.startsWith("/wisp/") &&
					hasAccess(req) &&
					isSameOriginWebSocket(req)
				) {
					wisp.routeRequest(req, socket, head);
					return;
				}

				socket.destroy();
			});
	},
});

fastify.addHook("onRequest", async (req, reply) => {
	if (!accessKey || req.url.startsWith("/__unlock")) return;
	if (hasAccess(req.raw)) return;

	return reply
		.code(401)
		.type("text/html; charset=utf-8")
		.header("Cache-Control", "no-store")
		.send(unlockHtml);
});

fastify.post("/__unlock", async (req, reply) => {
	if (!accessKey) return reply.code(404).send({ ok: false });

	const submitted =
		req.body && typeof req.body === "object" && "key" in req.body
			? String(req.body.key)
			: "";

	if (!safeEqual(submitted, accessKey)) {
		return reply
			.code(401)
			.header("Cache-Control", "no-store")
			.send({ ok: false });
	}

	reply.header(
		"Set-Cookie",
		`${accessCookieName}=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Strict`,
	);
	reply.header("Cache-Control", "no-store");
	return { ok: true };
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
	);
	console.log(
		accessKey
			? "Private access gate: enabled"
			: "Private access gate: disabled (set PROXY_ACCESS_KEY to enable)",
	);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = Number.parseInt(process.env.PORT || "", 10);
if (Number.isNaN(port)) port = 8080;

fastify.listen({
	port,
	host: "0.0.0.0",
});
