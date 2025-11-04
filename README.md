# Solutech Clip (Cloudflare Workers + Durable Objects)

Transferencia rápida de texto entre dispositivos con claves cortas y/o QR.
Sin VPS, usando Cloudflare Workers como backend (WebSockets) y Durable Objects como sala por clave.

## Requisitos
- Dominio en Cloudflare (p.ej. solutechpanama.com)
- Node.js y Wrangler instalados en tu PC:
  ```bash
  npm i -g wrangler
  wrangler login
  ```

## Estructura
```
wrangler.toml
src/worker.js
public/index.html
public/join.html
```

## Deploy
```bash
wrangler deploy
```

Luego en Cloudflare Dashboard > Workers & Pages > tu worker > **Custom domains**: añade `clip.solutechpanama.com`.

## Uso
1. Abre `https://clip.solutechpanama.com/` (index).
2. Pega el texto, marca **single-use** si quieres autodestrucción y crea sesión.
3. Comparte la **clave** o el **QR**. En el otro dispositivo abre `join.html` y escribe la clave (o entra con la URL del QR).
4. El texto aparece al instante. En single-use, pulsa **Marcar leído** para destruir la sesión.

## Notas de seguridad
- Todo el estado vive en el Durable Object y expira (TTL).
- No se escriben secretos en disco.
- Considera añadir cifrado E2E en cliente si vas a manejar contraseñas sensibles de clientes.
