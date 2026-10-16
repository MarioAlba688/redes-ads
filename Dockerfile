# Imagen de produccion de Redes (Next.js 16 + Prisma 7 + MySQL).
# Las variables de entorno NO se hornean en la imagen: se pasan al arrancar el contenedor (en Easypanel, pestana
# Environment). Para construirla no hace falta ninguna: la configuracion se lee al primer uso, no al compilar.

# --- Base comun: Node 22 + openssl (lo necesita el motor de migraciones de Prisma) -----------------------------
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- Construccion ---------------------------------------------------------------------------------------------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# `npm ci` ejecuta `postinstall` (prisma generate), que necesita el esquema y la configuracion de Prisma.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npm run build

# --- Ejecucion ------------------------------------------------------------------------------------------------
# Se copia la app completa (con node_modules) y no el modo "standalone" a proposito: el arranque aplica las
# migraciones con el CLI de Prisma, que es una dependencia de desarrollo. La imagen pesa mas, pero funciona igual
# que en tu PC.
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    MEDIA_DIR=/data/media
COPY --from=builder --chown=node:node /app ./
# Carpeta de imagenes de las publicaciones: monta aqui un volumen persistente (si no, se pierden al redesplegar).
RUN mkdir -p /data/media && chown -R node:node /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# sed quita los saltos de linea de Windows (CRLF), que romperian el script en Linux.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# /login es publica y responde sin tocar la sesion; start-period deja tiempo a las migraciones del primer arranque.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["start"]
