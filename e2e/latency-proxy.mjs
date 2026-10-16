// Intermediario TCP que retrasa cada paquete, para simular una base de datos lejana (p. ej. un VPS)
// en las pruebas. Con delayMs = 100 en cada sentido, una consulta tarda ~200 ms de ida y vuelta.

import net from "node:net";

export function startLatencyProxy({ targetHost = "127.0.0.1", targetPort, delayMs }) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    sockets.add(client).add(upstream);
    const pipe = (from, to) => {
      // Todos los paquetes se retrasan lo mismo, asi que el orden se conserva.
      from.on("data", (chunk) => setTimeout(() => to.writable && to.write(chunk), delayMs));
      from.on("end", () => setTimeout(() => to.end(), delayMs));
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}
