import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

const { routeRequest, routeUpgrade } = await bootstrap({
	transport: "libcurl",
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

				if (routeRequest(req, res)) return;
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (!routeUpgrade(req, socket, head)) socket.end();
			});
	},
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
