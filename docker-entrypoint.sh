#!/bin/sh
# Arranque del contenedor: prepara la carpeta de imagenes, aplica las migraciones y enciende la app.
set -e

# 1. Un volumen montado suele llegar como propiedad de root. Se le da la carpeta al usuario `node` y se baja de
#    privilegios: la app nunca corre como root. (`setpriv` reemplaza el proceso, asi las senales de parada llegan.)
if [ "$(id -u)" = "0" ]; then
  MEDIA="${MEDIA_DIR:-/data/media}"
  mkdir -p "$MEDIA"
  if [ "$(stat -c %u "$MEDIA")" != "$(id -u node)" ]; then
    chown -R node:node "$MEDIA"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

# Cualquier otro comando (por ejemplo `docker run ... sh`) se ejecuta tal cual.
if [ "$1" != "start" ]; then
  exec "$@"
fi

# 2. Migraciones pendientes. Si falla (base inalcanzable, clave mala), el contenedor se detiene y el motivo queda
#    en el registro, en vez de arrancar una app que no puede hablar con la base. RUN_MIGRATIONS=false las salta.
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  echo "[redes] Aplicando migraciones de la base de datos..."
  ./node_modules/.bin/prisma migrate deploy
fi

# 3. La app. El proceso en segundo plano (publicaciones programadas) arranca solo, dentro de ella.
echo "[redes] Arrancando en el puerto ${PORT:-3000}"
exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
